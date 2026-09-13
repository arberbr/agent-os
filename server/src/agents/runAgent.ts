import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { store } from '../store.js';
import type { AgentDef, ChatMessage, RunEvent, RunStep } from '../types.js';
import { chatCompletion, LLMError, parseJsonArgs, type LLMToolSpec } from '../llm/openaiCompat.js';
import { getTool, registerTool, toolToLLMSpec, type Tool, type ToolContext } from '../tools/registry.js';
import { getAuthedClient } from '../google/auth.js';
import { makeGithubClient } from '../github/client.js';
import { makeVercelClient } from '../vercel/client.js';
import { makeSupabaseClient } from '../supabase/client.js';
import { buildSystemPrompt } from './prompts.js';

export interface RunAgentOptions {
  agent: AgentDef;
  input: string;
  history?: ChatMessage[];
  onEvent: (event: RunEvent) => void;
  signal?: AbortSignal;
  /** Stack of agent ids currently executing (cycle protection for teams). */
  teamStack?: string[];
  runId?: string;
  /** Steps already recorded for this session, so a continued turn keeps one trace. */
  steps?: RunStep[];
}

export interface RunAgentResult {
  output: string;
  messages: ChatMessage[];
  steps: RunStep[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Run was cancelled.');
}

function truncate(value: unknown, max = config.toolResultMaxChars): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}\n…[truncated ${raw.length - max} chars]`;
}

function selectTools(agent: AgentDef): Tool[] {
  const tools: Tool[] = [];
  for (const name of agent.enabledTools) {
    const tool = getTool(name);
    if (tool && !tools.includes(tool)) tools.push(tool);
  }
  // A team lead can always delegate to its team.
  if (agent.teamAgentIds.length > 0) {
    const delegateTool = getTool('delegate');
    if (delegateTool && !tools.includes(delegateTool)) tools.push(delegateTool);
  }
  return tools;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { agent, input, onEvent, signal } = opts;
  const runId = opts.runId ?? randomUUID();
  const teamStack = [...(opts.teamStack ?? []), agent.id];
  const steps: RunStep[] = [...(opts.steps ?? [])];
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(agent) },
    ...(opts.history ?? []),
    { role: 'user', content: input },
  ];

  const emit = (step: RunStep): void => {
    steps.push(step);
    onEvent({ type: 'step', runId, step });
  };

  const [workspaceAuth, youtubeAuth] = await Promise.all([
    getAuthedClient('workspace').catch(() => null),
    getAuthedClient('youtube').catch(() => null),
  ]);

  const ctx: ToolContext = {
    agentId: agent.id,
    runId,
    googleAuth: { workspace: workspaceAuth, youtube: youtubeAuth },
    github: makeGithubClient(),
    vercel: makeVercelClient(),
    supabase: makeSupabaseClient(),
    signal,
    memory: {
      get: (key) => store.getAgentMemory(agent.id, key),
      set: (key, value) => store.setAgentMemory(agent.id, key, value),
      keys: () => Object.keys(store.listAgentMemory(agent.id)),
    },
    emitStep: emit,
    delegate: (childId, task) => delegateToAgent(childId, task, teamStack, onEvent, signal, runId),
  };

  const tools = selectTools(agent);
  const toolSpecs: LLMToolSpec[] = tools.map(toolToLLMSpec);
  const model = agent.model || config.llmModel;
  let consecutiveFailures = 0;

  for (let stepNo = 1; stepNo <= config.agentMaxSteps; stepNo++) {
    throwIfAborted(signal);
    emit({ index: steps.length, kind: 'llm', note: `thinking (step ${stepNo}/${config.agentMaxSteps})`, at: new Date().toISOString() });

    let response;
    const t0 = Date.now();
    try {
      response = await chatCompletion({
        messages,
        tools: toolSpecs.length ? toolSpecs : undefined,
        model,
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw new Error('Run was cancelled.');
      throw err instanceof LLMError ? err : new Error(`LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const llmMs = Date.now() - t0;

    const assistantMsg = response.message;
    messages.push(assistantMsg);
    onEvent({ type: 'message', runId, message: assistantMsg });

    const calls = assistantMsg.toolCalls ?? [];
    if (calls.length === 0) {
      const output = assistantMsg.content ?? '(no response)';
      emit({ index: steps.length, kind: 'llm', note: 'final answer', result: truncate(output, 2000), durationMs: llmMs, at: new Date().toISOString() });
      return { output, messages, steps };
    }

    emit({
      index: steps.length,
      kind: 'llm',
      note: `called ${calls.map((c) => c.name).join(', ')}`,
      durationMs: llmMs,
      at: new Date().toISOString(),
    });

    for (const call of calls) {
      throwIfAborted(signal);
      const tool = getTool(call.name);
      const callStart = Date.now();

      if (!tool) {
        const errText = `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ') || 'none'}.`;
        emit({ index: steps.length, kind: 'tool_call', toolName: call.name, args: parseJsonArgs(call.arguments), error: errText, at: new Date().toISOString() });
        messages.push({ role: 'tool', toolCallId: call.id, content: errText });
        consecutiveFailures++;
        continue;
      }

      let args: Record<string, unknown>;
      try {
        args = parseJsonArgs(call.arguments) as Record<string, unknown>;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('tool arguments must be a JSON object');
      } catch (err) {
        const errText = `Invalid arguments for ${tool.name}: ${err instanceof Error ? err.message : String(err)}`;
        emit({ index: steps.length, kind: 'tool_call', toolName: call.name, error: errText, at: new Date().toISOString() });
        messages.push({ role: 'tool', toolCallId: call.id, content: errText });
        consecutiveFailures++;
        continue;
      }

      emit({ index: steps.length, kind: 'tool_call', toolName: call.name, args, at: new Date().toISOString() });

      let result: string;
      try {
        const raw = await tool.execute(args, ctx);
        result = truncate(raw);
        consecutiveFailures = 0;
      } catch (err) {
        result = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
        consecutiveFailures++;
      }

      emit({
        index: steps.length,
        kind: 'tool_result',
        toolName: call.name,
        result,
        durationMs: Date.now() - callStart,
        at: new Date().toISOString(),
      });
      messages.push({ role: 'tool', toolCallId: call.id, content: result });

      if (consecutiveFailures >= 3) {
        throw new Error(`Aborting run: 3 tool failures in a row (last: ${call.name}). ${result}`);
      }
    }
  }

  // Hit the step limit: force a final summary without tools.
  emit({ index: steps.length, kind: 'note', note: `reached max steps (${config.agentMaxSteps}); summarizing`, at: new Date().toISOString() });
  const final = await chatCompletion({
    messages: [
      ...messages,
      { role: 'user', content: 'You have reached your step limit. Give the user a concise status: what was accomplished, what remains, and any recommended next actions. Do not call tools.' },
    ],
    model,
    toolChoice: 'none',
    signal,
  });
  messages.push(final.message);
  onEvent({ type: 'message', runId, message: final.message });
  return { output: final.message.content ?? '(no response)', messages, steps };
}

async function delegateToAgent(
  childId: string,
  task: string,
  teamStack: string[],
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal,
  parentRunId?: string,
): Promise<string> {
  const child = store.getAgent(childId);
  if (!child) return `Delegation failed: no agent with id ${childId}.`;
  if (teamStack.includes(childId)) return `Delegation refused: delegating to "${child.name}" would create a cycle (${[...teamStack, childId].map((id) => store.getAgent(id)?.name ?? id).join(' → ')}).`;

  const label = `delegate → ${child.name}`;
  onEvent({ type: 'step', runId: parentRunId ?? randomUUID(), step: { index: 0, kind: 'delegate', toolName: childId, note: `started sub-agent "${child.name}"`, at: new Date().toISOString() } });

  const result = await runAgent({
    agent: child,
    input: task,
    onEvent,
    signal,
    teamStack,
  });

  onEvent({ type: 'step', runId: parentRunId ?? randomUUID(), step: { index: 0, kind: 'delegate', toolName: childId, note: `finished sub-agent "${child.name}"`, at: new Date().toISOString() } });

  const summary = truncate(result.output, 6000);
  return `Sub-agent "${child.name}" finished. Its report:\n${summary}`;
}

// The delegation tool is defined here because it drives the runtime itself.
registerTool({
  name: 'delegate',
  description: 'Hand a well-scoped sub-task to one of your team agents and wait for its report. Give the task as a complete brief: goal, relevant context, expected deliverable.',
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string', description: 'Id of the team agent to delegate to' },
      task: { type: 'string', description: 'Complete brief for the sub-agent' },
    },
    required: ['agentId', 'task'],
    additionalProperties: false,
  },
  async execute(args, ctx) {
    const agentId = String(args.agentId ?? '');
    const task = String(args.task ?? '');
    if (!agentId || !task) throw new Error('agentId and task are required');
    return ctx.delegate(agentId, task);
  },
});
