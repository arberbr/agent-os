import { config } from '../config.js';
import { store } from '../store.js';
import type { AgentDef, Run, RunEvent, RunStatus, RunStep } from '../types.js';
import { runAgent } from './runAgent.js';
import { buildHistory, conversationMessages } from './history.js';

export interface ExecuteTurnOptions {
  agent: AgentDef;
  /** The session record this turn belongs to (already created/marked running). */
  run: Run;
  input: string;
  signal: AbortSignal;
  /** Receives every event as it happens — the SSE route forwards it to the client. */
  onEvent?: (event: RunEvent) => void;
  /** Leading activity note, e.g. "scheduled run · every weekday at 09:00". */
  note?: string;
}

export interface ExecuteTurnResult {
  status: RunStatus;
  output: string | null;
  error: string | null;
}

/**
 * Answer one turn of a session, end to end.
 *
 * One turn is: replay the stored transcript into the model context, run the
 * agent loop, and persist everything as it streams (so a crash mid-turn still
 * leaves a consistent history). This lives apart from the HTTP route because a
 * turn has two entry points now — a user typing in the run view, and the
 * scheduler firing a schedule with nobody watching.
 */
export async function executeTurn(options: ExecuteTurnOptions): Promise<ExecuteTurnResult> {
  const { agent, run, input, signal, onEvent, note } = options;

  // Split the stored transcript: `priorMessages` is this turn's starting point
  // (it is put back verbatim), `history` is the replayable prefix that fits the
  // context budget.
  const priorMessages = conversationMessages(run.messages);
  const history = buildHistory(run.messages, config.conversationHistoryMaxChars);

  // The step list is tracked locally as well as in the store: `run.steps` is
  // replaced (not mutated) on every persist, and `runAgent` must be handed the
  // list that already contains this turn's opening note.
  const steps: RunStep[] = [...run.steps];

  const emit = (event: RunEvent): void => {
    onEvent?.(event);
    if (event.type === 'step' && event.step) {
      steps.push(event.step);
      store.updateRun(run.id, { steps: [...steps] });
    }
    if (event.type === 'message' && event.message) {
      store.updateRun(run.id, { messages: [...(store.getRun(run.id)?.messages ?? []), event.message] });
    }
  };

  if (note) {
    emit({
      type: 'step',
      runId: run.id,
      step: { index: steps.length, kind: 'note', note, at: new Date().toISOString() },
    });
  }

  try {
    const result = await runAgent({
      agent,
      input,
      history,
      steps,
      runId: run.id,
      signal,
      onEvent: emit,
    });
    const cancelled = signal.aborted;
    // `result.messages` is the whole request context; only this turn's tail
    // belongs in the stored transcript (the history prefix may have been
    // trimmed to fit the context budget, but persistence stays complete).
    const turnMessages = result.messages.slice(1 + history.length);
    const status: RunStatus = cancelled ? 'cancelled' : 'completed';
    const output = cancelled ? null : result.output;
    store.updateRun(run.id, {
      status,
      messages: [...priorMessages, ...turnMessages],
      steps: result.steps,
      output,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    return { status, output, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: RunStatus = signal.aborted ? 'cancelled' : 'failed';
    store.updateRun(run.id, {
      status,
      error: message,
      finishedAt: new Date().toISOString(),
    });
    return { status, output: null, error: message };
  }
}
