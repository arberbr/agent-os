import { isValidEmail } from '../auth.js';
import { describeCron } from '../schedules/cron.js';
import type { RunStatus, Schedule, ScheduleNotifyOn } from '../types.js';

/**
 * The notification email: who gets it, when it is due, and what it says.
 *
 * Everything here is pure — no store, no transport, no clock beyond the stamps
 * it is given — so the wording, the recipient rules and the HTML escaping can
 * be tested directly, which is the only way a "did it email me?" feature stays
 * trustworthy.
 *
 * The mail is deliberately **light**: the console is a dark instrument, but a
 * run report lands in mail clients that force-invert dark backgrounds and mangle
 * them. It keeps the family resemblance through structure and the same accent
 * and state colours, on a warm stone page instead of a black one.
 */

const MAX_OUTPUT_CHARS = 4000;
const MAX_RECIPIENTS = 10;

export const NOTIFY_MODES: ScheduleNotifyOn[] = ['never', 'failure', 'success', 'always'];

export function isNotifyMode(value: unknown): value is ScheduleNotifyOn {
  return typeof value === 'string' && (NOTIFY_MODES as string[]).includes(value);
}

/**
 * Is a notification due for this outcome? `cancelled` counts as a failure: a
 * run cut short by a restart or a stop is exactly the kind of silent outcome
 * worth an email.
 */
export function shouldNotify(mode: ScheduleNotifyOn, status: RunStatus): boolean {
  if (mode === 'never') return false;
  if (status === 'running') return false;
  const ok = status === 'completed';
  if (mode === 'always') return true;
  return mode === 'success' ? ok : !ok;
}

/**
 * Who the notification goes to: the account that created the schedule, plus any
 * addresses added on the schedule. Duplicates (same address in different case)
 * collapse to one, and unusable entries are dropped rather than handed to the
 * relay to bounce.
 */
export function resolveRecipients(
  schedule: Pick<Schedule, 'notifyEmails'>,
  creatorEmail: string | null | undefined,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string | null | undefined): void => {
    const email = (raw ?? '').trim();
    if (!email || !isValidEmail(email)) return;
    const key = email.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(email);
  };

  add(creatorEmail);
  for (const extra of schedule.notifyEmails ?? []) add(extra);
  return out.slice(0, MAX_RECIPIENTS);
}

/** Addresses a schedule may be given, validated and de-duplicated. */
export function cleanNotifyEmails(values: unknown): string[] | null {
  const list = Array.isArray(values) ? values : String(values ?? '').split(',');
  const out: string[] = [];
  for (const raw of list) {
    const email = String(raw).trim();
    if (!email) continue;
    if (!isValidEmail(email)) return null;
    if (!out.some((existing) => existing.toLowerCase() === email.toLowerCase())) out.push(email);
  }
  return out.slice(0, MAX_RECIPIENTS);
}

/* ── The message ───────────────────────────────────────────────────────── */

export interface ScheduleNotificationInput {
  /** The settled schedule record (label, cadence, next firing, pause reason). */
  schedule: Schedule;
  /** The run this notification reports on. */
  runId: string;
  /** What the console prints as the schedule's name. */
  label: string;
  agentName: string;
  status: RunStatus;
  error: string | null;
  output: string | null;
  steps: number;
  startedAt: string;
  finishedAt: string | null;
  /** Who fired it: the engine on its cadence, or a person pressing Run now. */
  trigger: 'schedule' | 'manual';
  /** Base URL of the console, for the link back to the run. */
  consoleUrl: string;
}

export interface ScheduleNotification {
  subject: string;
  text: string;
  html: string;
}

export function scheduleNotification(input: ScheduleNotificationInput): ScheduleNotification {
  const { status } = input;
  const state = STATUS_WORD[status] ?? status;
  const subject =
    status === 'completed'
      ? `[Agents OS] ${input.label} — completed`
      : `[Agents OS] ${input.label} — ${state}`;

  return {
    subject: subject.slice(0, 200),
    text: textBody(input, state),
    html: htmlBody(input, state),
  };
}

const STATUS_WORD: Record<string, string> = {
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  running: 'running',
};

/** Status colours, echoing the console's state palette on a light surface. */
const TONE = {
  completed: { ink: '#1f6b46', soft: '#e6f4ec', rule: '#bfe0cc', word: 'Completed' },
  failed: { ink: '#a8271d', soft: '#fbeae8', rule: '#f0c9c4', word: 'Failed' },
  cancelled: { ink: '#8a6100', soft: '#fbf1dc', rule: '#ecd9a9', word: 'Cancelled' },
  running: { ink: '#0f6f66', soft: '#e2f4f1', rule: '#bfe3de', word: 'Running' },
} as const;

function toneFor(status: RunStatus) {
  return TONE[status as keyof typeof TONE] ?? TONE.running;
}

function truncateOutput(output: string | null): { body: string; truncated: boolean } {
  const text = (output ?? '').trim();
  if (text.length <= MAX_OUTPUT_CHARS) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

/* ── Plaintext ─────────────────────────────────────────────────────────── */

function textBody(input: ScheduleNotificationInput, state: string): string {
  const { body, truncated } = truncateOutput(input.output);
  const lines: string[] = [
    `AGENTS OS · SCHEDULED RUN ${state.toUpperCase()}`,
    ''.padEnd(64, '─'),
    '',
    input.label,
    '',
    row('Agent', input.agentName),
    row('Cadence', describeCron(input.schedule.cron)),
    row('Trigger', input.trigger === 'manual' ? 'run by hand' : 'on schedule'),
    row('Started', moment(input.startedAt)),
    row('Finished', input.finishedAt ? moment(input.finishedAt) : '—'),
    row('Duration', duration(input.startedAt, input.finishedAt)),
    row('Steps', String(input.steps)),
    row('Status', state),
  ];

  if (input.schedule.pausedReason) {
    lines.push('', `PAUSED  ${input.schedule.pausedReason}`);
  }

  lines.push('', 'TASK', ''.padEnd(64, '─'), indent(input.schedule.input));
  if (input.error) lines.push('', 'ERROR', ''.padEnd(64, '─'), indent(input.error));
  if (body) {
    lines.push('', input.error ? 'OUTPUT SO FAR' : 'OUTPUT', ''.padEnd(64, '─'), indent(body));
    if (truncated) lines.push('', `…output truncated at ${MAX_OUTPUT_CHARS} characters.`);
  }

  lines.push(
    '',
    ''.padEnd(64, '─'),
    `Run in the console: ${runUrl(input)}`,
    `Schedule: ${input.consoleUrl}/schedules`,
    '',
    'You are receiving this because notifications are on for this schedule.',
    'Turn them off in the schedule editor, or in Settings → Email notifications.',
  );
  return lines.join('\n');
}

function row(label: string, value: string): string {
  return `${label.padEnd(10)}${value}`;
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line ? `  ${line}` : ''))
    .join('\n');
}

function runUrl(input: ScheduleNotificationInput): string {
  return `${input.consoleUrl}/runs?run=${encodeURIComponent(input.runId)}`;
}

/* ── HTML ──────────────────────────────────────────────────────────────── */

function htmlBody(input: ScheduleNotificationInput, state: string): string {
  const tone = toneFor(input.status);
  const { body, truncated } = truncateOutput(input.output);
  const url = runUrl(input);

  const meta: Array<[string, string]> = [
    ['Agent', escapeHtml(input.agentName)],
    ['Cadence', escapeHtml(describeCron(input.schedule.cron))],
    ['Trigger', input.trigger === 'manual' ? 'Run by hand' : 'On schedule'],
    ['Started', escapeHtml(moment(input.startedAt))],
    ['Duration', escapeHtml(duration(input.startedAt, input.finishedAt))],
    ['Steps', String(input.steps)],
  ];
  if (input.schedule.nextRunAt && input.schedule.enabled) {
    meta.push(['Next run', escapeHtml(moment(input.schedule.nextRunAt))]);
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.label)} — ${escapeHtml(state)}</title></head>
<body style="margin:0;padding:28px 16px;background:#eeeee9;color:#191a17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;">
<div style="max-width:620px;margin:0 auto;">

  <div style="margin:0 0 14px 2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#71756a;">
    Agents OS · scheduled run
  </div>

  <div style="background:#fbfbf8;border:1px solid #dedfd7;border-radius:16px;overflow:hidden;">

    <div style="padding:22px 24px 20px;border-bottom:1px solid #dedfd7;">
      <div style="display:inline-block;padding:3px 10px;border-radius:999px;background:${tone.soft};border:1px solid ${tone.rule};color:${tone.ink};font-size:12px;font-weight:600;letter-spacing:.02em;">
        ${escapeHtml(tone.word)}
      </div>
      <h1 style="margin:12px 0 0;font-size:21px;line-height:1.3;font-weight:600;letter-spacing:-.01em;color:#191a17;">
        ${escapeHtml(input.label)}
      </h1>
      <div style="margin:8px 0 0;color:#71756a;font-size:13.5px;">
        ${escapeHtml(input.trigger === 'manual' ? 'Run by hand' : 'Fired on its cadence')}${input.trigger === 'manual' ? ` · ${escapeHtml(describeCron(input.schedule.cron))}` : ''}
      </div>
    </div>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
      ${meta
        .map(
          ([label, value], index) => `<tr>
        <td style="padding:9px 24px;${index > 0 ? 'border-top:1px solid #eceae3;' : ''}width:110px;color:#71756a;font-size:13px;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:9px 24px;${index > 0 ? 'border-top:1px solid #eceae3;' : ''}font-size:13.5px;vertical-align:top;">${value}</td>
      </tr>`,
        )
        .join('')}
    </table>

    ${
      input.schedule.pausedReason
        ? `<div style="margin:0;padding:14px 24px;border-top:1px solid #ecd9a9;background:#fbf1dc;">
      <div style="font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:#8a6100;">Schedule paused</div>
      <div style="margin-top:3px;font-size:13.5px;color:#5e4a12;">${escapeHtml(input.schedule.pausedReason)}</div>
    </div>`
        : ''
    }

    <div style="padding:18px 24px 20px;border-top:1px solid #dedfd7;">
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71756a;">Task</div>
      <div style="margin-top:7px;font-size:14px;color:#2e3029;">${escapeHtml(input.schedule.input)}</div>
    </div>

    ${
      input.error
        ? `<div style="padding:18px 24px 20px;border-top:1px solid #f0c9c4;background:#fbeae8;">
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#a8271d;">Error</div>
      <div style="margin-top:7px;font-size:13.5px;color:#5c1a15;white-space:pre-wrap;">${escapeHtml(input.error)}</div>
    </div>`
        : ''
    }

    ${
      body
        ? `<div style="padding:18px 24px 20px;border-top:1px solid #dedfd7;">
      <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#71756a;">${input.error ? 'Output so far' : 'Output'}</div>
      <pre style="margin:9px 0 0;padding:14px 16px;background:#f4f4f0;border:1px solid #e4e4de;border-radius:9px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:#23251f;">${escapeHtml(body)}</pre>
      ${truncated ? `<div style="margin-top:8px;font-size:12.5px;color:#8a8d82;">Output truncated at ${MAX_OUTPUT_CHARS} characters — the full run is in the console.</div>` : ''}
    </div>`
        : ''
    }

    <div style="padding:18px 24px;border-top:1px solid #dedfd7;background:#f7f7f3;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:9px 16px;border-radius:9px;background:#0d9488;color:#ffffff;font-size:13.5px;font-weight:600;text-decoration:none;">Open the run in the console</a>
      <div style="margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;color:#8a8d82;word-break:break-all;">${escapeHtml(url)}</div>
    </div>

  </div>

  <div style="margin:14px 2px 0;color:#8a8d82;font-size:12px;">
    Notifications are on for this schedule. Change that in the schedule editor, or switch the relay off in
    <a href="${escapeHtml(input.consoleUrl)}/settings" style="color:#0d9488;">Settings → Email notifications</a>.
  </div>

</div>
</body></html>`;
}

/* ── Formatting ────────────────────────────────────────────────────────── */

/** "Sep 11, 09:00" — the same shape the console prints, in the server's zone. */
export function moment(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "12s" / "1m 04s" — mirrors formatDuration in the web console. */
export function duration(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
