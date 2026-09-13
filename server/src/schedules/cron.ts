/**
 * Cron engine — dependency-free, five-field cron with the semantics Vixie cron
 * uses (`minute hour day-of-month month day-of-week`).
 *
 * Supported syntax per field: `*`, a single value, a range (`a-b`), a step
 * (`*` followed by `/n`, or `a-b/n`, or `a/n` = "every n from a"), and
 * comma-separated lists of any of those. Month and weekday accept the usual
 * three-letter names (`JAN`, `MON`) as well as numbers, and Sunday is both `0`
 * and `7`. The usual macros expand:
 * `@hourly @daily @midnight @weekly @monthly @yearly`.
 *
 * Times are evaluated in the **server's local time zone** — a self-hosted
 * instance schedules against the clock of the machine it runs on, and the
 * console renders "next run" in that same zone.
 *
 * `nextRun` is a field-level search (months → days → hours → minutes) rather
 * than a minute-by-minute scan, so even the pathological cases (`0 0 29 2 *`,
 * a date that only exists every four years) resolve instantly.
 */

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
/** Spelled-out names, used only when describing a cadence to a human. */
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** How far ahead `nextRun` searches before giving up (Feb 29 needs up to 8). */
const SEARCH_YEARS = 8;

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

export interface CronSpec {
  /** The normalized expression (macros expanded, whitespace collapsed). */
  expr: string;
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** False when the field is `*` — needed for cron's day-of-month OR rule. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

export interface CronValidation {
  valid: boolean;
  error?: string;
}

interface FieldSpec {
  min: number;
  max: number;
  names?: string[];
  /** Value that aliases another (7 = Sunday). */
  alias?: Record<number, number>;
  label: string;
}

const FIELDS: FieldSpec[] = [
  { min: 0, max: 59, label: 'minute' },
  { min: 0, max: 23, label: 'hour' },
  { min: 1, max: 31, label: 'day of month' },
  { min: 1, max: 12, names: MONTH_NAMES, label: 'month' },
  { min: 0, max: 7, names: DAY_NAMES, alias: { 7: 0 }, label: 'day of week' },
];

class CronError extends Error {}

/** Resolve a name (`JAN`) or a number to its value, or throw a readable error. */
function resolveValue(token: string, field: FieldSpec): number {
  const named = field.names?.indexOf(token.toUpperCase()) ?? -1;
  if (named >= 0) return named + field.min;
  if (!/^\d+$/.test(token)) {
    throw new CronError(`"${token}" is not a valid ${field.label} (use a number${field.names ? ` or ${field.names.join('/')}` : ''}).`);
  }
  const value = Number(token);
  if (value < field.min || value > field.max) {
    throw new CronError(`${value} is out of range for the ${field.label} field (${field.min}-${field.max}).`);
  }
  return value;
}

function parseField(raw: string, field: FieldSpec): number[] {
  const values = new Set<number>();
  for (const term of raw.split(',')) {
    const piece = term.trim();
    if (!piece) throw new CronError(`Empty entry in the ${field.label} field.`);

    const [rangePart, stepPart, ...extra] = piece.split('/');
    if (extra.length > 0) throw new CronError(`"${piece}" has more than one "/" in the ${field.label} field.`);

    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new CronError(`"${piece}" needs a positive step (e.g. */5) in the ${field.label} field.`);
      }
      step = Number(stepPart);
    }

    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = field.min;
      to = field.max;
    } else if (rangePart!.includes('-')) {
      const [a, b, ...rest] = rangePart!.split('-');
      if (rest.length > 0 || !a || !b) {
        throw new CronError(`"${piece}" is not a valid range in the ${field.label} field.`);
      }
      from = resolveValue(a, field);
      to = resolveValue(b, field);
      if (from > to) {
        throw new CronError(`"${piece}" counts backwards in the ${field.label} field (start must be ≤ end).`);
      }
    } else {
      from = resolveValue(rangePart!, field);
      // "a/n" means "every n starting at a" (cron shorthand for a-max/n).
      to = stepPart === undefined ? from : field.max;
    }

    for (let value = from; value <= to; value += step) {
      values.add(field.alias?.[value] ?? value);
    }
  }

  // 7 and 0 both mean Sunday: normalizing can leave a duplicate.
  return [...values].sort((a, b) => a - b);
}

/** Parse and normalize an expression, throwing a user-facing message. */
export function parseCron(expression: string): CronSpec {
  const raw = String(expression ?? '').trim();
  if (!raw) throw new CronError('A schedule needs a cron expression.');
  const expr = MACROS[raw.toLowerCase()] ?? raw;
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronError(
      `Expected 5 fields — minute, hour, day of month, month, day of week — but got ${parts.length} ("${raw}"). ` +
        'For example: "0 9 * * 1-5" runs at 09:00 on weekdays.',
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parts.map((part, i) =>
    parseField(part!, FIELDS[i]!),
  );
  return {
    expr: parts.join(' '),
    minutes: minutes!,
    hours: hours!,
    daysOfMonth: daysOfMonth!,
    months: months!,
    daysOfWeek: daysOfWeek!,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

/** Never throws: used by the API to answer "is this expression usable?". */
export function validateCron(expression: string): CronValidation {
  try {
    parseCron(expression);
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Cron's day rule: when both day fields are restricted, either one may match. */
function dayMatches(spec: CronSpec, date: Date): boolean {
  const dom = spec.daysOfMonth.includes(date.getDate());
  const dow = spec.daysOfWeek.includes(date.getDay());
  if (!spec.domRestricted && !spec.dowRestricted) return true;
  if (!spec.domRestricted) return dow;
  if (!spec.dowRestricted) return dom;
  return dom || dow;
}

/** Smallest listed value ≥ current, or null when the list is exhausted. */
function nextValue(values: number[], current: number): number | null {
  return values.find((value) => value >= current) ?? null;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * The first matching minute strictly after `from`, or null when the
 * expression cannot match within the search horizon (`0 0 31 2 *`).
 */
export function nextRun(expression: string, from: Date = new Date()): Date | null {
  const spec = parseCron(expression);
  // Cron granularity is a minute: the next run is always in a later minute.
  let cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const horizon = new Date(cursor.getTime());
  horizon.setFullYear(horizon.getFullYear() + SEARCH_YEARS);

  while (cursor <= horizon) {
    if (!spec.months.includes(cursor.getMonth() + 1)) {
      // Skip to the first day of the next month.
      const before = cursor.getTime();
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 0, 0, 0, 0);
      if (cursor.getTime() <= before) return null;
      continue;
    }
    if (!dayMatches(spec, cursor)) {
      const before = cursor.getTime();
      cursor = startOfDay(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1));
      if (cursor.getTime() <= before) return null;
      continue;
    }
    if (!spec.hours.includes(cursor.getHours())) {
      const hour = nextValue(spec.hours, cursor.getHours() + 1);
      if (hour === null) {
        const before = cursor.getTime();
        cursor = startOfDay(new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1));
        if (cursor.getTime() <= before) return null;
        continue;
      }
      const before = cursor.getTime();
      cursor.setHours(hour, 0, 0, 0);
      if (cursor.getTime() <= before) return null;
      continue;
    }
    if (!spec.minutes.includes(cursor.getMinutes())) {
      const minute = nextValue(spec.minutes, cursor.getMinutes() + 1);
      if (minute === null) {
        const before = cursor.getTime();
        // No minute left in this hour: move to the next hour and retry.
        cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
        if (cursor.getTime() <= before) return null;
        continue;
      }
      const before = cursor.getTime();
      cursor.setMinutes(minute, 0, 0);
      if (cursor.getTime() <= before) return null;
      continue;
    }
    return cursor;
  }
  return null;
}

/** The next `count` matching minutes, for previews. */
export function nextRuns(expression: string, count = 3, from: Date = new Date()): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < Math.max(1, count); i++) {
    const next = nextRun(expression, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** All values of a field (every minute, every hour, …). */
function full(values: number[], field: FieldSpec): boolean {
  return values.length === field.max - field.min + 1;
}

function sameSet(values: number[], wanted: number[]): boolean {
  return values.length === wanted.length && wanted.every((value) => values.includes(value));
}

function dayNames(days: number[]): string {
  return days.map((day) => DAY_FULL[day]!).join(', ');
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

/**
 * A short human label for an expression ("Every weekday at 09:00").
 *
 * The common cadences are matched on the *fields*, not on derived sets, so an
 * expression is only ever described as something simpler than it is — anything
 * unusual falls through to `Custom · <expr>` rather than being described
 * wrongly.
 */
export function describeCron(expression: string): string {
  let spec: CronSpec;
  try {
    spec = parseCron(expression);
  } catch {
    return String(expression ?? '');
  }

  const [fMinute = '', fHour = ''] = spec.expr.split(' ');
  const everyHour = full(spec.hours, FIELDS[1]!);
  const everyMonth = full(spec.months, FIELDS[3]!);
  const daysFree = !spec.domRestricted && !spec.dowRestricted;
  const minuteStep = /^\*\/(\d+)$/.exec(fMinute);
  const hourStep = /^\*\/(\d+)$/.exec(fHour);

  // Every N minutes / every N hours.
  if ((fMinute === '*' || minuteStep) && everyHour && daysFree) {
    const step = minuteStep ? Number(minuteStep[1]) : 1;
    return step === 1 ? 'Every minute' : `Every ${step} minutes`;
  }
  if (hourStep && firesEveryHour(spec) && daysFree) {
    const step = Number(hourStep[1]);
    return step === 1 ? 'Every hour' : `Every ${step} hours`;
  }

  const minute = spec.minutes.length === 1 ? spec.minutes[0]! : null;
  const hour = spec.hours.length === 1 ? spec.hours[0]! : null;

  if (minute !== null && everyHour && daysFree) return `Hourly at :${pad(minute)}`;

  if (minute !== null && hour !== null) {
    const at = clock(hour, minute);
    if (daysFree) return hour === 0 && minute === 0 ? 'Every day at midnight' : `Every day at ${at}`;

    if (spec.dowRestricted && !spec.domRestricted) {
      if (sameSet(spec.daysOfWeek, WEEKDAYS)) return `Every weekday at ${at}`;
      if (sameSet(spec.daysOfWeek, WEEKEND)) return `Weekends at ${at}`;
      if (spec.daysOfWeek.length === 7) return `Every day at ${at}`;
      return `Every ${dayNames(spec.daysOfWeek)} at ${at}`;
    }
    if (!spec.dowRestricted && spec.months.length === 1) {
      const name = MONTH_FULL[spec.months[0]! - 1]!;
      if (spec.daysOfMonth.length === 1) return `Yearly on ${name} ${spec.daysOfMonth[0]} at ${at}`;
      return `Every ${name} at ${at}`;
    }
    if (!spec.dowRestricted && everyMonth && spec.daysOfMonth.length === 1) {
      const dom = spec.daysOfMonth[0]!;
      return dom === 1 ? `Monthly on the 1st at ${at}` : `Monthly on day ${dom} at ${at}`;
    }
  }

  // A short list of fixed times on free days ("Every day at 09:00, 17:00").
  if (minute !== null && spec.hours.length <= 4 && daysFree) {
    return `Every day at ${spec.hours.map((h) => clock(h, minute)).join(', ')}`;
  }

  return `Custom · ${spec.expr}`;
}

/**
 * True when the minute field repeats identically in every hour — either one
 * fixed minute, or all of them (with the hours stepping).
 */
function firesEveryHour(spec: CronSpec): boolean {
  return spec.minutes.length === 1 || (spec.minutes.length === 60 && spec.expr.startsWith('* '));
}
