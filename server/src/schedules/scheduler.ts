import { config } from '../config.js';
import { store } from '../store.js';
import type { Run, RunStatus, Schedule } from '../types.js';
import { executeTurn } from '../agents/executeRun.js';
import { describeCron, nextRun } from './cron.js';

export type ScheduleTrigger = 'schedule' | 'manual';

/**
 * The scheduler — cron-style recurring agent runs.
 *
 * It is deliberately a plain interval over the store rather than a job queue:
 * a self-hosted instance has one JSON database, one process and a handful of
 * schedules, so "look for work every N seconds" is the whole design. What it
 * does guarantee is that nothing is ever run twice:
 *
 *  - **one run per schedule at a time** — a schedule whose previous run is
 *    still going is skipped, not stacked, and the next occurrence is recomputed
 *    from the moment the run *finishes*;
 *  - **missed occurrences are skipped, never replayed** — on boot `nextRunAt`
 *    is recomputed from now, so a machine that was off overnight does not wake
 *    up and fire a night of backlog;
 *  - **bounded concurrency** (`SCHEDULE_MAX_CONCURRENCY`) — work beyond the cap
 *    stays due and is picked up on a later tick, which is the backpressure;
 *  - **a schedule that keeps failing pauses itself** (`SCHEDULE_MAX_FAILURES`)
 *    with the reason recorded, instead of burning API credit in a loop.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  /** Schedules with a run in flight: schedule id → that run. */
  private readonly inFlight = new Map<string, Run>();
  /** Abort controllers for in-flight runs, so shutdown can stop them. */
  private readonly controllers = new Map<string, AbortController>();
  private ticking = false;

  /** Begin ticking. Does nothing when the engine is off or already running. */
  start(): void {
    if (!config.scheduler.enabled) {
      console.log('[scheduler] disabled (SCHEDULER_ENABLED=false) — schedules will not fire.');
      return;
    }
    if (this.timer) return;
    this.reconcile();
    const everyMs = config.scheduler.tickSeconds * 1000;
    // A failed tick must never take the process down: an unattended engine
    // that dies on one bad pass would silently stop every schedule.
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('[scheduler] tick failed:', err));
    }, everyMs);
    // The HTTP listener is what keeps the process alive; the tick must not.
    this.timer.unref?.();
    const scheduled = store.listSchedules();
    const active = scheduled.filter((s) => s.enabled && s.nextRunAt).length;
    console.log(
      `[scheduler] every ${config.scheduler.tickSeconds}s · ${active}/${scheduled.length} schedule(s) armed · ` +
        `up to ${config.scheduler.maxConcurrency} at a time`,
    );
  }

  /** Stop ticking and abort in-flight scheduled runs (shutdown path). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  isEnabled(): boolean {
    return config.scheduler.enabled;
  }

  /** Ids of the schedules executing right now (the console shows them live). */
  runningIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /**
   * Bring the stored schedules in line with reality after a restart: close
   * runs that were interrupted, park schedules whose agent is gone, and
   * recompute every next firing from *now*.
   */
  private reconcile(): void {
    const interrupted = store.failInterruptedRuns();
    if (interrupted > 0) console.log(`[scheduler] closed ${interrupted} run(s) interrupted by the last shutdown.`);

    let paused = 0;
    for (const schedule of store.listSchedules()) {
      // Nothing is in flight at boot, so a schedule still marked "running"
      // lost its run to the restart (the run itself was closed just above).
      if (schedule.lastStatus === 'running') {
        store.updateSchedule(schedule.id, {
          lastStatus: 'failed',
          lastError: schedule.lastError ?? 'Interrupted by a server restart.',
        });
      }
      const agent = store.getAgent(schedule.agentId);
      if (!agent) {
        store.updateSchedule(schedule.id, { enabled: false, nextRunAt: null, pausedReason: 'The agent was deleted.' });
        paused++;
        continue;
      }
      if (!schedule.enabled) {
        if (schedule.nextRunAt !== null) store.updateSchedule(schedule.id, { nextRunAt: null });
        continue;
      }
      const next = this.computeNext(schedule);
      if (next.paused) {
        store.updateSchedule(schedule.id, { enabled: false, nextRunAt: null, pausedReason: next.reason });
        paused++;
        continue;
      }
      // Only write when the stored plan actually differs, so a restart does
      // not rewrite every schedule for nothing.
      if (schedule.nextRunAt !== next.at || schedule.pausedReason !== null) {
        store.updateSchedule(schedule.id, { nextRunAt: next.at, pausedReason: null });
      }
    }
    if (paused > 0) console.log(`[scheduler] ${paused} schedule(s) paused (missing agent or unusable cadence).`);
  }

  /**
   * When a schedule should fire next. A cadence that cannot match anything
   * (`0 0 31 2 *`) is reported as a pause rather than left silently armed.
   */
  private computeNext(schedule: Schedule, from: Date = new Date()): { at: string | null; paused: boolean; reason: string | null } {
    try {
      const next = nextRun(schedule.cron, from);
      if (!next) {
        return { at: null, paused: true, reason: `"${schedule.cron}" never matches a real date.` };
      }
      return { at: next.toISOString(), paused: false, reason: null };
    } catch (err) {
      return { at: null, paused: true, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Recompute a stored schedule's next firing (after an edit or a resume). */
  refresh(scheduleId: string): Schedule | undefined {
    const schedule = store.getSchedule(scheduleId);
    if (!schedule) return undefined;
    if (!schedule.enabled) return store.updateSchedule(scheduleId, { nextRunAt: null });
    const next = this.computeNext(schedule);
    return store.updateSchedule(
      scheduleId,
      next.paused ? { enabled: false, nextRunAt: null, pausedReason: next.reason } : { nextRunAt: next.at, pausedReason: null },
    );
  }

  /** One pass: fire every schedule that is due, within the concurrency cap. */
  async tick(now: Date = new Date()): Promise<Run[]> {
    if (!config.scheduler.enabled || this.ticking) return [];
    this.ticking = true;
    const started: Run[] = [];
    try {
      for (const schedule of store.listDueSchedules(now)) {
        // Work beyond the cap stays due for a later tick — that is the
        // backpressure that keeps an unattended box from melting.
        if (this.inFlight.size >= config.scheduler.maxConcurrency) break;
        const run = this.launch(schedule, 'schedule');
        if (run) started.push(run);
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }

  /**
   * Fire a schedule on demand, from the console. Works on a paused schedule
   * too — pressing "Run now" is an explicit decision, and running it does not
   * re-arm the cadence.
   */
  runNow(scheduleId: string): Run | string {
    const schedule = store.getSchedule(scheduleId);
    if (!schedule) return 'Schedule not found.';
    if (this.inFlight.has(schedule.id)) return 'That schedule already has a run in flight.';
    if (!store.getAgent(schedule.agentId)) return 'The agent for this schedule no longer exists.';
    const run = this.launch(schedule, 'manual');
    return run ?? 'The run could not be started.';
  }

  /**
   * Create the run record and hand execution to the background. Returns
   * synchronously so a tick never blocks on a model call: the caller gets the
   * run, the engine keeps its single-flight bookkeeping.
   */
  private launch(schedule: Schedule, trigger: ScheduleTrigger): Run | null {
    const agent = store.getAgent(schedule.agentId);
    if (!agent) return null;
    if (this.inFlight.has(schedule.id)) return null;

    const label = schedule.name.trim() || agent.name;
    // A scheduled run is a session of its own, titled after the task it was
    // given, tagged with the schedule that fired it.
    const run = store.createRun(agent.id, schedule.input.slice(0, 100) || label, schedule.createdBy, schedule.id);
    store.pruneRuns(store.getSettings().runHistoryLimit);

    this.inFlight.set(schedule.id, run);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);

    // Advance the cadence before the model call, so a long run does not look
    // overdue while it is still working.
    const armed = schedule.enabled ? this.computeNext(schedule) : { at: null, paused: false, reason: null };
    store.updateSchedule(schedule.id, {
      lastRunAt: run.startedAt,
      lastRunId: run.id,
      lastStatus: 'running',
      lastError: null,
      runCount: schedule.runCount + 1,
      nextRunAt: armed.paused ? null : armed.at,
    });

    const note =
      trigger === 'manual'
        ? `manual run from "${label}" · ${describeCron(schedule.cron)}`
        : `scheduled run · ${describeCron(schedule.cron)}`;

    void this.execute(schedule, run, controller, note);
    return run;
  }

  /** The background half of a firing: run the agent, then settle the record. */
  private async execute(schedule: Schedule, run: Run, controller: AbortController, note: string): Promise<void> {
    const agent = store.getAgent(schedule.agentId);
    try {
      if (!agent) throw new Error('The agent for this schedule no longer exists.');
      const result = await executeTurn({
        agent,
        run,
        input: schedule.input,
        signal: controller.signal,
        note,
      });
      this.settle(schedule, result.status, result.error);
      console.log(`[scheduler] "${schedule.name || agent.name}" → ${result.status} (run ${run.id.slice(0, 8)})`);
    } catch (err) {
      // executeTurn records a failed run itself, so reaching this means the
      // firing broke before that was possible (a missing agent, a store error).
      const message = err instanceof Error ? err.message : String(err);
      this.settle(schedule, 'failed', message);
      console.error(`[scheduler] "${schedule.name}" failed:`, message);
    } finally {
      this.inFlight.delete(schedule.id);
      this.controllers.delete(run.id);
    }
  }

  /**
   * Write the outcome of a firing onto the schedule: the last-run fields, the
   * consecutive-failure counter, and either the next firing or the self-pause
   * that ends the cadence.
   */
  private settle(schedule: Schedule, status: RunStatus, error: string | null): void {
    const current = store.getSchedule(schedule.id) ?? schedule;
    const failed = status === 'failed';
    const failures = failed ? current.failures + 1 : 0;
    const patch: Partial<Schedule> = { lastStatus: status, lastError: error, failures };

    const limit = config.scheduler.maxFailures;
    if (failed && limit > 0 && failures >= limit) {
      patch.enabled = false;
      patch.nextRunAt = null;
      patch.pausedReason = `Paused after ${failures} consecutive failures: ${error ?? 'unknown error'}`;
    } else if (current.enabled) {
      // Recomputed from *now*: a firing that overran its cadence does not
      // queue up the occurrences it missed.
      patch.nextRunAt = this.computeNext(current).at;
    }
    store.updateSchedule(schedule.id, patch);
  }
}

export const scheduler = new Scheduler();
