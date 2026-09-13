import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeCron, nextRun, nextRuns, parseCron, validateCron } from './cron.js';

/**
 * The cron engine is the only part of the scheduler that can be wrong without
 * anyone noticing, so it is tested directly: `node --test` over the parsing,
 * the next-firing search and the human labels. Every date is built with the
 * local-time constructor, so the expectations hold in any time zone.
 */

/* ── Parsing ───────────────────────────────────────────────────────────── */

test('parses steps, ranges, lists and names', () => {
  assert.deepEqual(parseCron('*/15 * * * *').minutes, [0, 15, 30, 45]);
  assert.deepEqual(parseCron('0 9 * * MON-FRI').daysOfWeek, [1, 2, 3, 4, 5]);
  assert.deepEqual(parseCron('0 0 1 JAN *').months, [1]);
  assert.deepEqual(parseCron('0 0,12 * * *').hours, [0, 12]);
  assert.deepEqual(parseCron('0 8-18/2 * * *').hours, [8, 10, 12, 14, 16, 18]);
  // "a/n" is the documented shorthand for "every n starting at a".
  assert.deepEqual(parseCron('5/20 * * * *').minutes, [5, 25, 45]);
});

test('normalizes Sunday and expands macros', () => {
  assert.deepEqual(parseCron('0 0 * * 7').daysOfWeek, [0]);
  assert.deepEqual(parseCron('0 0 * * sun').daysOfWeek, [0]);
  assert.deepEqual(parseCron('@daily').minutes, [0]);
  assert.deepEqual(parseCron('@hourly').hours, new Array(24).fill(0).map((_, i) => i));
  assert.equal(parseCron('@weekly').expr, '0 0 * * 0');
});

test('rejects what it cannot honor, with a usable message', () => {
  const cases = ['', '0 9 * *', '0 9 * * * *', '60 0 * * *', '0 25 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8'];
  for (const expression of cases) {
    const check = validateCron(expression);
    assert.equal(check.valid, false, `"${expression}" should be rejected`);
    assert.ok((check.error ?? '').length > 10, `"${expression}" needs a readable error`);
  }
  assert.equal(validateCron('10-5 * * * *').valid, false, 'backwards range');
  assert.equal(validateCron('*/0 * * * *').valid, false, 'zero step');
  assert.equal(validateCron('0 9 * * 1-5').valid, true);
});

/* ── Next firing ───────────────────────────────────────────────────────── */

test('finds the next match strictly after the given minute', () => {
  // Fri 11 Sep 2026, 10:00 → the next weekday 09:00 is Monday the 14th.
  const next = nextRun('0 9 * * 1-5', new Date(2026, 8, 11, 10, 0))!;
  assert.deepEqual(
    [next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()],
    [2026, 8, 14, 9, 0],
  );

  // Seconds never leak in: the run time is the minute.
  const stepped = nextRun('*/15 * * * *', new Date(2026, 8, 11, 10, 7, 42))!;
  assert.deepEqual([stepped.getHours(), stepped.getMinutes(), stepped.getSeconds()], [10, 15, 0]);

  // A field that is already past rolls to the next hour, not to the same one.
  const hourly = nextRun('0 * * * *', new Date(2026, 8, 11, 10, 0))!;
  assert.deepEqual([hourly.getHours(), hourly.getMinutes()], [11, 0]);

  // Every 6 hours from 10:07 → 12:00 the same day.
  const sixHourly = nextRun('0 */6 * * *', new Date(2026, 8, 11, 10, 7))!;
  assert.deepEqual([sixHourly.getDate(), sixHourly.getHours()], [11, 12]);
});

test('handles month rolls, leap days and impossible dates', () => {
  // Monthly on the 1st, asked on the last day of the month.
  const monthly = nextRun('0 0 1 * *', new Date(2026, 8, 30, 12, 0))!;
  assert.deepEqual([monthly.getMonth(), monthly.getDate()], [9, 1]);

  // Feb 29 only exists in a leap year: 2028 is the next one after 2026.
  const leap = nextRun('0 0 29 2 *', new Date(2026, 2, 1, 0, 0))!;
  assert.deepEqual([leap.getFullYear(), leap.getMonth(), leap.getDate()], [2028, 1, 29]);

  // Cron's day rule: when both day fields are set, either one may match —
  // from Fri 11 Sep 2026 the next "13th or Friday" is Sunday the 13th.
  const either = nextRun('0 0 13 * 5', new Date(2026, 8, 11, 10, 0))!;
  assert.deepEqual([either.getDate(), either.getMonth()], [13, 8]);

  // A date that does not exist never fires, and says so instead of hanging.
  assert.equal(nextRun('0 0 31 2 *', new Date(2026, 0, 1)), null);
});

test('nextRuns walks forward without repeating itself', () => {
  const runs = nextRuns('30 6 * * *', 3, new Date(2026, 8, 11, 12, 0));
  assert.equal(runs.length, 3);
  assert.deepEqual(runs.map((d) => d.getDate()), [12, 13, 14]);
  const stamps = runs.map((d) => d.getTime());
  assert.deepEqual([...stamps].sort((a, b) => a - b), stamps, 'results must be strictly increasing');
  assert.equal(nextRuns('0 0 31 2 *', 3, new Date(2026, 0, 1)).length, 0);
});

/* ── Human labels ──────────────────────────────────────────────────────── */

test('describes cadences the way the console shows them', () => {
  assert.equal(describeCron('* * * * *'), 'Every minute');
  assert.equal(describeCron('*/30 * * * *'), 'Every 30 minutes');
  assert.equal(describeCron('0 * * * *'), 'Hourly at :00');
  assert.equal(describeCron('0 0 * * *'), 'Every day at midnight');
  assert.equal(describeCron('30 6 * * *'), 'Every day at 06:30');
  assert.equal(describeCron('0 9 * * 1-5'), 'Every weekday at 09:00');
  assert.equal(describeCron('0 10 * * 0,6'), 'Weekends at 10:00');
  assert.equal(describeCron('0 9 * * 1'), 'Every Monday at 09:00');
  assert.equal(describeCron('0 0 1 * *'), 'Monthly on the 1st at 00:00');
  assert.equal(describeCron('0 12 15 * *'), 'Monthly on day 15 at 12:00');
  assert.equal(describeCron('0 0 1 1 *'), 'Yearly on January 1 at 00:00');
  assert.equal(describeCron('0 9,17 * * *'), 'Every day at 09:00, 17:00');
  assert.equal(describeCron('0 */6 * * *'), 'Every 6 hours');
  // An unusual cadence is shown as-is rather than described wrongly.
  assert.equal(describeCron('7 3 2,9 * *'), 'Custom · 7 3 2,9 * *');
  assert.equal(describeCron('nonsense'), 'nonsense');
});
