import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanNotifyEmails, duration, isNotifyMode, moment, resolveRecipients, scheduleNotification, shouldNotify,
} from './message.js';
import type { RunStatus, Schedule } from '../types.js';

/**
 * The notification email is a promise made to a person ("tell me when my
 * schedule breaks"), and every part of it that can be wrong — who it goes to,
 * whether it was due at all, what it says, whether a task containing HTML can
 * inject markup into the mail — is decided by these pure functions. So they are
 * tested directly, including the escaping, which is the one that matters.
 */

/** A complete schedule record, built literally so nothing here touches the store. */
function schedule(overrides: Partial<Schedule> = {}): Schedule {
  const now = '2026-09-11T07:00:00.000Z';
  return {
    id: 'sched-1',
    agentId: 'agent-1',
    name: 'Morning inbox triage',
    input: 'Triage my inbox: summarise anything unread.',
    cron: '0 8 * * 1-5',
    enabled: true,
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    nextRunAt: '2026-09-14T08:00:00.000Z',
    lastRunAt: '2026-09-11T08:00:00.000Z',
    lastRunId: 'run-1',
    lastStatus: 'failed',
    lastError: null,
    runCount: 12,
    failures: 1,
    pausedReason: null,
    notifyOn: 'failure',
    notifyEmails: [],
    lastNotifyAt: null,
    lastNotifyError: null,
    ...overrides,
  };
}

const baseInput = {
  schedule: schedule(),
  runId: 'run-1',
  label: 'Morning inbox triage',
  agentName: 'Executive Assistant',
  status: 'failed' as RunStatus,
  error: 'Gmail API quota exceeded.',
  output: null as string | null,
  steps: 7,
  startedAt: '2026-09-11T08:00:00.000Z',
  finishedAt: '2026-09-11T08:02:04.000Z',
  trigger: 'schedule' as const,
  consoleUrl: 'http://localhost:5173',
};

/* ── When a notification is due ────────────────────────────────────────── */

test('never is never, whatever happened', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'running'] as RunStatus[]) {
    assert.equal(shouldNotify('never', status), false, `never / ${status}`);
  }
});

test('failure reports the two ways a run can go wrong, not the good outcome', () => {
  assert.equal(shouldNotify('failure', 'failed'), true);
  assert.equal(shouldNotify('failure', 'cancelled'), true, 'a run cut short is a failure worth hearing about');
  assert.equal(shouldNotify('failure', 'completed'), false);
});

test('success is the mirror of failure', () => {
  assert.equal(shouldNotify('success', 'completed'), true);
  assert.equal(shouldNotify('success', 'failed'), false);
  assert.equal(shouldNotify('success', 'cancelled'), false);
});

test('every run means every settled run, and never a live one', () => {
  assert.equal(shouldNotify('always', 'completed'), true);
  assert.equal(shouldNotify('always', 'failed'), true);
  assert.equal(shouldNotify('always', 'cancelled'), true);
  assert.equal(shouldNotify('always', 'running'), false, 'a run still going has no outcome to report');
});

test('only the four documented modes are accepted', () => {
  assert.equal(isNotifyMode('failure'), true);
  assert.equal(isNotifyMode('sometimes'), false);
  assert.equal(isNotifyMode(undefined), false);
});

/* ── Recipients ────────────────────────────────────────────────────────── */

test('the creator is notified even when the schedule lists nobody', () => {
  assert.deepEqual(resolveRecipients(schedule(), 'me@example.com'), ['me@example.com']);
});

test('extra addresses are added to the creator, not swapped for it', () => {
  const recipients = resolveRecipients(
    schedule({ notifyEmails: ['team@example.com'] }),
    'me@example.com',
  );
  assert.deepEqual(recipients, ['me@example.com', 'team@example.com']);
});

test('duplicates collapse, whatever their case, and junk is dropped', () => {
  const recipients = resolveRecipients(
    schedule({ notifyEmails: ['ME@example.com', 'not-an-email', 'second@example.com', 'second@example.com'] }),
    'me@example.com',
  );
  assert.deepEqual(recipients, ['me@example.com', 'second@example.com']);
});

test('a schedule with no creator still reaches its own list', () => {
  const recipients = resolveRecipients(schedule({ createdBy: null, notifyEmails: ['team@example.com'] }), null);
  assert.deepEqual(recipients, ['team@example.com']);
});

test('submitted addresses are validated before they are stored', () => {
  assert.deepEqual(cleanNotifyEmails('a@example.com, b@example.com'), ['a@example.com', 'b@example.com']);
  assert.deepEqual(cleanNotifyEmails(['a@example.com']), ['a@example.com']);
  assert.deepEqual(cleanNotifyEmails(''), []);
  assert.equal(cleanNotifyEmails('a@example.com, oops'), null, 'one bad address rejects the whole submission');
  assert.equal(cleanNotifyEmails(['@example.com']), null);
});

/* ── Subject and body ──────────────────────────────────────────────────── */

test('the subject names the schedule and its outcome', () => {
  assert.equal(
    scheduleNotification({ ...baseInput, status: 'completed', error: null }).subject,
    '[Agents OS] Morning inbox triage — completed',
  );
  assert.equal(
    scheduleNotification({ ...baseInput, status: 'failed' }).subject,
    '[Agents OS] Morning inbox triage — failed',
  );
  assert.equal(
    scheduleNotification({ ...baseInput, status: 'cancelled' }).subject,
    '[Agents OS] Morning inbox triage — cancelled',
  );
});

test('the plaintext report carries the facts, the task, the error and the link', () => {
  const { text } = scheduleNotification({ ...baseInput, status: 'failed' });
  assert.match(text, /Executive Assistant/);
  assert.match(text, /Every weekday at 08:00/);
  assert.match(text, /Triage my inbox/);
  assert.match(text, /Gmail API quota exceeded\./);
  assert.match(text, /2m 04s/);
  assert.match(text, /http:\/\/localhost:5173\/runs\?run=run-1/);
});

test('a manual run says so, because it was not the cadence that fired it', () => {
  const manual = scheduleNotification({ ...baseInput, trigger: 'manual', status: 'completed', error: null });
  assert.match(manual.text, /run by hand/);
  assert.match(manual.html, /Run by hand/);

  const fired = scheduleNotification({ ...baseInput, status: 'completed', error: null });
  assert.match(fired.text, /on schedule/);
});

test('a paused schedule explains why it stopped', () => {
  const paused = scheduleNotification({
    ...baseInput,
    schedule: schedule({ pausedReason: 'Paused after 5 consecutive failures: quota exceeded' }),
    status: 'failed',
  });
  assert.match(paused.text, /Paused after 5 consecutive failures/);
  assert.match(paused.html, /Schedule paused/);
});

test('the output is included, and a long one is cut rather than mailed whole', () => {
  const short = scheduleNotification({ ...baseInput, status: 'completed', error: null, output: 'All clear.' });
  assert.match(short.text, /All clear\./);

  const long = scheduleNotification({
    ...baseInput,
    status: 'completed',
    error: null,
    output: 'x'.repeat(9000),
  });
  assert.match(long.text, /output truncated at 4000 characters/i);
  assert.equal(long.text.includes('x'.repeat(4001)), false);
  // The HTML says it too, so a reader who never sees the plaintext still knows.
  assert.match(long.html, /Output truncated at 4000 characters/);
});

test('a failed run shows the error section, and its partial output is labelled as such', () => {
  const failed = scheduleNotification({ ...baseInput, status: 'failed', output: 'half a report' });
  assert.match(failed.text, /ERROR/);
  assert.match(failed.text, /OUTPUT SO FAR/);
  assert.match(failed.html, /Output so far/);
});

test('a task containing markup cannot escape into the mail', () => {
  const injected = scheduleNotification({
    ...baseInput,
    schedule: schedule({ input: '<script>alert(1)</script> "quoted" & ampersand' }),
    output: '<img src=x onerror=alert(2)>',
  });
  assert.equal(injected.html.includes('<script>'), false);
  assert.equal(injected.html.includes('<img src=x'), false);
  assert.match(injected.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(injected.html, /&amp; ampersand/);
  // The plaintext is not markup, so it keeps what the operator actually wrote.
  assert.match(injected.text, /<script>alert\(1\)<\/script>/);
});

test('a schedule label cannot break out of the subject either', () => {
  const { subject } = scheduleNotification({
    ...baseInput,
    label: `${'long '.repeat(80)}name`,
  });
  assert.ok(subject.length <= 200, 'the subject stays inside the RFC line budget');
});

test('the HTML is a complete document with the console link and the opt-out note', () => {
  const { html } = scheduleNotification({ ...baseInput, status: 'completed', error: null });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html>/);
  assert.match(html, /<\/html>$/);
  assert.match(html, /http:\/\/localhost:5173\/runs\?run=run-1/);
  assert.match(html, /Settings → Email notifications/);
});

/* ── Formatting ────────────────────────────────────────────────────────── */

test('durations read like the console, and missing stamps stay honest', () => {
  assert.equal(duration('2026-09-11T08:00:00.000Z', '2026-09-11T08:00:12.000Z'), '12s');
  assert.equal(duration('2026-09-11T08:00:00.000Z', '2026-09-11T08:02:04.000Z'), '2m 04s');
  assert.equal(duration(null, '2026-09-11T08:02:04.000Z'), '—');
  assert.equal(duration('2026-09-11T08:02:04.000Z', '2026-09-11T08:00:00.000Z'), '—');
});

test('an unusable stamp never prints "Invalid Date"', () => {
  assert.equal(moment(null), '—');
  assert.equal(moment('not a date'), '—');
  assert.notEqual(moment('2026-09-11T08:00:00.000Z'), '—');
});
