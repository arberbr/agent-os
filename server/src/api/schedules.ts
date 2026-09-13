import express from 'express';
import { store } from '../store.js';
import { scheduler } from '../schedules/scheduler.js';
import { describeCron, nextRun, nextRuns, validateCron } from '../schedules/cron.js';
import { cleanNotifyEmails, isNotifyMode } from '../mail/message.js';
import { mailSender } from '../mail/sender.js';
import type { Schedule, ScheduleNotifyOn } from '../types.js';

/** The shape the console renders — a schedule joined to what it needs to show. */
function scheduleView(schedule: Schedule) {
  const agent = store.getAgent(schedule.agentId);
  return {
    ...schedule,
    agentName: agent?.name ?? 'deleted agent',
    agentColor: agent?.color ?? '#8f939c',
    /** What the console prints as the schedule's name. */
    label: schedule.name.trim() || agent?.name || 'Deleted agent',
    /** Human cadence, e.g. "Every weekday at 09:00". */
    description: describeCron(schedule.cron),
    createdByEmail: schedule.createdBy ? store.getUser(schedule.createdBy)?.email ?? null : null,
    /** True while this schedule's run is executing right now. */
    running: scheduler.runningIds().includes(schedule.id),
    /**
     * Who a notification would reach (the creator plus any extra addresses),
     * and whether the relay is even switched on — so the editor can say what
     * will happen instead of leaving the operator to guess.
     */
    notifyRecipients: schedule.notifyOn === 'never'
      ? []
      : resolvedRecipients(schedule),
    mailConfigured: mailSender.isConfigured(),
  };
}

/** The creator's address plus the schedule's own list, as the sender would use it. */
function resolvedRecipients(schedule: Schedule): string[] {
  const creator = schedule.createdBy ? store.getUser(schedule.createdBy)?.email ?? null : null;
  return [...new Set([creator, ...(schedule.notifyEmails ?? [])].filter((email): email is string => Boolean(email)))];
}

/** Longest task text accepted from the console (a brief, not a document). */
const MAX_INPUT_CHARS = 4000;

interface SchedulePatch {
  agentId?: string;
  name?: string;
  input?: string;
  cron?: string;
  enabled?: boolean;
  notifyOn?: ScheduleNotifyOn;
  notifyEmails?: string[];
}

/**
 * Validate whatever subset of the fields the caller sent. Partial on purpose:
 * the list view flips `enabled` on its own, while the editor posts everything.
 */
function readSchedulePatch(body: Record<string, unknown>): SchedulePatch {
  const patch: SchedulePatch = {};

  if (body.agentId !== undefined) {
    const agentId = String(body.agentId).trim();
    if (!agentId) throw new Error('Pick the agent this schedule should run.');
    if (!store.getAgent(agentId)) throw new Error('That agent no longer exists.');
    patch.agentId = agentId;
  }
  if (body.name !== undefined) {
    patch.name = String(body.name).trim().slice(0, 120);
  }
  if (body.input !== undefined) {
    const input = String(body.input).trim();
    if (!input) throw new Error('The task the agent should run is required.');
    patch.input = input.slice(0, MAX_INPUT_CHARS);
  }
  if (body.cron !== undefined) {
    const cron = String(body.cron).trim();
    const check = validateCron(cron);
    if (!check.valid) throw new Error(check.error);
    patch.cron = cron;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new Error('"enabled" must be true or false.');
    patch.enabled = body.enabled;
  }
  if (body.notifyOn !== undefined) {
    if (!isNotifyMode(body.notifyOn)) {
      throw new Error('"notifyOn" must be one of: never, failure, success, always.');
    }
    if (body.notifyOn !== 'never' && !mailSender.isConfigured()) {
      // Storing it would be a promise the server cannot keep. Refusing here is
      // how the operator finds out now rather than after a silent 3am failure.
      throw new Error('Email notifications need an SMTP relay — an administrator can add one in Settings.');
    }
    patch.notifyOn = body.notifyOn;
  }
  if (body.notifyEmails !== undefined) {
    const emails = cleanNotifyEmails(body.notifyEmails);
    if (emails === null) throw new Error('Recipients must be valid email addresses, separated by commas.');
    patch.notifyEmails = emails;
  }
  return patch;
}

/** Error message when a cadence can never fire, else null. */
function unusableCadence(cron: string): string | null {
  return nextRun(cron) ? null : `"${cron}" never matches a real date. Check the day and month fields.`;
}

/**
 * Scheduled runs: create, edit, pause and fire cron-style recurring agent runs.
 * Mounted behind `requireAuth` in api/app.ts — the workspace is shared, so any
 * signed-in account manages the schedules it can see (who created each one is
 * recorded and shown).
 */
export function createScheduleRouter(): express.Router {
  const router = express.Router();

  /** Enabled schedules first, soonest to fire at the top. */
  const ordered = () =>
    store.listSchedules().sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.enabled) return String(a.nextRunAt).localeCompare(String(b.nextRunAt));
      return a.createdAt.localeCompare(b.createdAt);
    });

  router.get('/', (_req, res) => {
    res.json(ordered().map(scheduleView));
  });

  /**
   * Cadence check for the editor: validation plus the next few firing times,
   * so a wrong expression is caught before it is saved rather than at 3am.
   */
  router.post('/preview', (req, res) => {
    const body = (req.body ?? {}) as { cron?: unknown; count?: unknown };
    const cron = String(body.cron ?? '').trim();
    const check = validateCron(cron);
    if (!check.valid) return res.json({ valid: false, error: check.error, cron, description: '', next: [] });

    const count = Math.min(Math.max(Number(body.count) || 3, 1), 5);
    const dates = nextRuns(cron, count).map((date) => date.toISOString());
    if (dates.length === 0) {
      return res.json({
        valid: false,
        error: `"${cron}" never matches a real date. Check the day and month fields.`,
        cron,
        description: describeCron(cron),
        next: [],
      });
    }
    return res.json({ valid: true, cron, description: describeCron(cron), next: dates });
  });

  router.post('/', (req, res) => {
    try {
      const patch = readSchedulePatch((req.body ?? {}) as Record<string, unknown>);
      if (!patch.agentId) throw new Error('Pick the agent this schedule should run.');
      if (!patch.input) throw new Error('The task the agent should run is required.');
      if (!patch.cron) throw new Error('A cadence is required (a 5-field cron expression).');

      const enabled = patch.enabled !== false;
      if (enabled) {
        const problem = unusableCadence(patch.cron);
        if (problem) throw new Error(problem);
      }

      const schedule = store.createSchedule({
        agentId: patch.agentId,
        name: patch.name ?? '',
        input: patch.input,
        cron: patch.cron,
        enabled,
        createdBy: req.user?.id ?? null,
        nextRunAt: enabled ? nextRun(patch.cron)!.toISOString() : null,
        lastRunAt: null,
        lastRunId: null,
        lastStatus: null,
        lastError: null,
        runCount: 0,
        failures: 0,
        pausedReason: null,
        notifyOn: patch.notifyOn ?? 'never',
        notifyEmails: patch.notifyEmails ?? [],
        lastNotifyAt: null,
        lastNotifyError: null,
      });
      res.status(201).json(scheduleView(schedule));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get('/:id', (req, res) => {
    const schedule = store.getSchedule(req.params.id);
    if (!schedule) return res.status(404).json({ error: 'Schedule not found.' });
    res.json(scheduleView(schedule));
  });

  router.put('/:id', (req, res) => {
    const existing = store.getSchedule(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Schedule not found.' });
    try {
      const patch = readSchedulePatch((req.body ?? {}) as Record<string, unknown>);
      const cron = patch.cron ?? existing.cron;
      const enabled = patch.enabled ?? existing.enabled;
      if (enabled) {
        const problem = unusableCadence(cron);
        if (problem) throw new Error(problem);
      }

      // Editing a schedule is an explicit fresh start: whatever paused it —
      // repeated failures, a deleted agent that is back — no longer applies.
      const redefined = patch.input !== undefined || patch.cron !== undefined || patch.agentId !== undefined;
      // Re-saving the notification settings is likewise a fresh start for the
      // "could not send" note, which is usually what the edit was fixing.
      const notifyTouched = patch.notifyOn !== undefined || patch.notifyEmails !== undefined;
      const updated = store.updateSchedule(existing.id, {
        ...patch,
        failures: 0,
        pausedReason: null,
        lastError: redefined ? null : existing.lastError,
        lastNotifyError: notifyTouched ? null : existing.lastNotifyError,
      });
      if (!updated) return res.status(404).json({ error: 'Schedule not found.' });
      const refreshed = scheduler.refresh(updated.id) ?? updated;
      res.json(scheduleView(refreshed));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.delete('/:id', (req, res) => {
    if (!store.deleteSchedule(req.params.id)) {
      return res.status(404).json({ error: 'Schedule not found.' });
    }
    res.status(204).end();
  });

  /** Fire now, without touching the cadence. */
  router.post('/:id/run', (req, res) => {
    const outcome = scheduler.runNow(req.params.id);
    if (typeof outcome === 'string') {
      return res.status(outcome === 'Schedule not found.' ? 404 : 409).json({ error: outcome });
    }
    res.status(202).json({ runId: outcome.id, schedule: scheduleView(store.getSchedule(req.params.id)!) });
  });

  return router;
}
