import { config } from '../config.js';
import { store } from '../store.js';
import type { Run, RunStatus, Schedule } from '../types.js';
import { resolveRecipients, scheduleNotification, shouldNotify } from './message.js';
import { mailSender } from './sender.js';

/**
 * The hook between the scheduler and the mail sender: a scheduled run just
 * settled, so decide whether anyone asked to hear about it and tell them.
 *
 * Two rules shape everything here:
 *
 *  - **it can never break the engine.** A firing's outcome is already recorded
 *    by the time this runs; a dead relay, a rejected address or a missing
 *    credential downgrades to a line on the schedule and a log entry, never to
 *    a failed run or a paused schedule.
 *  - **it says what happened.** Whatever it decided — sent, switched off, no
 *    recipients — comes back as a value, and the two states an operator would
 *    want to fix are written onto the schedule so the console can show them.
 */

export type NotifyOutcome =
  | { sent: true; to: string[]; messageId: string }
  | { sent: false; reason: NotifySkipReason; detail: string };

export type NotifySkipReason =
  /** The schedule is set to Never. */
  | 'off'
  /** The outcome does not match the schedule's notify mode. */
  | 'not-due'
  /** No relay is configured (or it is switched off) in Settings. */
  | 'not-configured'
  /** Nobody to write to. */
  | 'no-recipients'
  /** The relay was tried and refused the message. */
  | 'send-failed';

export interface ScheduleOutcome {
  /** The settled schedule record, as stored after the run finished. */
  schedule: Schedule;
  run: Run;
  agentName: string;
  status: RunStatus;
  error: string | null;
  trigger: 'schedule' | 'manual';
}

export async function notifyScheduleOutcome(outcome: ScheduleOutcome): Promise<NotifyOutcome> {
  const { schedule } = outcome;

  if (schedule.notifyOn === 'never') {
    return { sent: false, reason: 'off', detail: 'Notifications are switched off for this schedule.' };
  }
  if (!shouldNotify(schedule.notifyOn, outcome.status)) {
    return {
      sent: false,
      reason: 'not-due',
      detail: `Nothing to report for a ${outcome.status} run under "${schedule.notifyOn}".`,
    };
  }
  if (!mailSender.isConfigured()) {
    const detail = 'No email relay is configured — add SMTP credentials in Settings → Email notifications.';
    await record(schedule, { lastNotifyError: detail });
    return { sent: false, reason: 'not-configured', detail };
  }

  const creator = schedule.createdBy ? store.getUser(schedule.createdBy) : undefined;
  const to = resolveRecipients(schedule, creator?.email ?? null);
  if (to.length === 0) {
    const detail = 'Nobody to notify: the schedule has no recipients and no account that created it.';
    await record(schedule, { lastNotifyError: detail });
    return { sent: false, reason: 'no-recipients', detail };
  }

  const label = schedule.name.trim() || outcome.agentName;
  const mail = scheduleNotification({
    schedule,
    runId: outcome.run.id,
    label,
    agentName: outcome.agentName,
    status: outcome.status,
    error: outcome.error,
    output: outcome.run.output,
    steps: outcome.run.steps.length,
    startedAt: outcome.run.startedAt,
    finishedAt: outcome.run.finishedAt,
    trigger: outcome.trigger,
    consoleUrl: config.consoleUrl,
  });

  try {
    const result = await mailSender.send({
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      // Provenance the receiving side can filter on, and the console can too.
      headers: {
        'X-Agents-OS-Schedule': schedule.id,
        'X-Agents-OS-Run': outcome.run.id,
      },
    });
    await record(schedule, { lastNotifyAt: new Date().toISOString(), lastNotifyError: null });
    console.log(
      `[mail] "${label}" ${outcome.status} → ${result.accepted.join(', ') || to.join(', ')} (run ${outcome.run.id.slice(0, 8)})`,
    );
    return { sent: true, to, messageId: result.messageId };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await record(schedule, { lastNotifyError: detail });
    console.error(`[mail] "${label}" could not be reported:`, detail);
    return { sent: false, reason: 'send-failed', detail };
  }
}

/** Write the notification bookkeeping back onto the schedule. */
async function record(schedule: Schedule, patch: Partial<Schedule>): Promise<void> {
  try {
    store.updateSchedule(schedule.id, patch);
  } catch (err) {
    // A store hiccup must not turn into a rejected notification path.
    console.error('[mail] could not record the notification outcome:', err);
  }
}
