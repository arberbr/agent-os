import { config } from '../config.js';
import type { ChatMessage, ToolCall } from '../types.js';

export interface LLMToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  message: ChatMessage;
  finishReason: string;
  usage?: { promptTokens?: number; completionTokens?: number };
}

export class LLMError extends Error {}

function parseJsonArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content ?? '' };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content ?? null,
      // DeepSeek V4 requires reasoning_content passback on assistant messages
      // that emitted tool calls; other providers ignore unknown fields.
      ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

function fromOpenAIMessage(msg: Record<string, unknown>): ChatMessage {
  const role = (msg['role'] as string) ?? 'assistant';
  const content = (msg['content'] as string | null | undefined) ?? null;
  const rawCalls = msg['tool_calls'];
  const toolCalls: ToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      const rc = raw as Record<string, unknown>;
      const fn = (rc['function'] ?? {}) as Record<string, unknown>;
      toolCalls.push({
        id: (rc['id'] as string) ?? crypto.randomUUID(),
        name: (fn['name'] as string) ?? 'unknown',
        arguments: (fn['arguments'] as string) ?? '{}',
      });
    }
  }
  const reasoning = msg['reasoning_content'];
  return {
    role: role as ChatMessage['role'],
    content,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    reasoningContent: typeof reasoning === 'string' ? reasoning : undefined,
  };
}

export interface ChatCompletionParams {
  messages: ChatMessage[];
  tools?: LLMToolSpec[];
  model?: string;
  toolChoice?: 'auto' | 'none';
  signal?: AbortSignal;
  /** Hint from the UI so tool-call arguments can be surfaced in the stream. */
  onToolCalls?: (calls: ToolCall[]) => void;
}

/**
 * Offline demo brain. Understands a tiny DSL so the whole agent loop —
 * including tool calls and team delegation — can be exercised with no API key:
 *   "mock:tools …"                    → calls the first no-args tool, then stops
 *   "mock:delegate:<agentId> <task>"  → calls the delegate tool with those args
 * Anything else → a plain final answer.
 */
function mockCompletion(params: ChatCompletionParams): LLMResponse {
  const last = params.messages[params.messages.length - 1];
  if (last?.role === 'tool') {
    return {
      message: { role: 'assistant', content: '[mock LLM] Tool executed successfully. (With a real LLM configured, reasoning would continue here.)' },
      finishReason: 'stop',
    };
  }

  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  const text = String(lastUser?.content ?? '');

  const delegateMatch = text.match(/mock:delegate:(\S+)\s+([\s\S]*)/);
  if (delegateMatch && delegateMatch[1] && params.tools?.some((t) => t.function.name === 'delegate')) {
    return {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: 'mock-delegate',
          name: 'delegate',
          arguments: JSON.stringify({ agentId: delegateMatch[1], task: delegateMatch[2]?.trim() || 'Do your thing.' }),
        }],
      },
      finishReason: 'tool_calls',
    };
  }

  if (/mock:tools/.test(text)) {
    const callable = params.tools?.find((t) => {
      const req = (t.function.parameters as { required?: unknown } | undefined)?.required;
      return !Array.isArray(req) || req.length === 0;
    });
    if (callable) {
      return {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'mock-tool', name: callable.function.name, arguments: '{}' }],
        },
        finishReason: 'tool_calls',
      };
    }
  }

  return {
    message: {
      role: 'assistant',
      content: `[mock LLM] Received: "${text.slice(0, 160)}". Configure a real LLM in .env (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL) to make me think for real.`,
    },
    finishReason: 'stop',
  };
}

/**
 * Provider-agnostic chat completion via any OpenAI-compatible endpoint
 * (OpenAI, DeepSeek, Gemini OpenAI-compat, OpenRouter, local vLLM, ...).
 * Also supports a `mock` provider for offline demos/smoke tests.
 */
export async function chatCompletion(params: ChatCompletionParams): Promise<LLMResponse> {
  if (config.llmMock) {
    return mockCompletion(params);
  }

  if (!config.llmApiKey && !config.llmBaseUrl.includes('localhost') && !config.llmBaseUrl.includes('127.0.0.1')) {
    throw new LLMError('No LLM_API_KEY configured. Add one in .env (or set LLM_PROVIDER=mock for offline mode).');
  }

  const url = `${config.llmBaseUrl}/chat/completions`;
  const body: Record<string, unknown> = {
    model: params.model || config.llmModel,
    messages: params.messages.map(toOpenAIMessage),
  };
  if (params.tools?.length) body['tools'] = params.tools;
  if (params.tools?.length) body['tool_choice'] = params.toolChoice ?? 'auto';
  // DeepSeek V4 optional thinking mode (unknown fields are ignored by OpenAI
  // and most other providers, but this only fires when explicitly configured).
  if (config.llmThinkingMode) body['thinking'] = { type: config.llmThinkingMode };
  if (config.llmThinkingMode === 'enabled' && config.llmReasoningEffort) body['reasoning_effort'] = config.llmReasoningEffort;

  const attempt = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
          ...config.llmExtraHeaders,
        },
        body: JSON.stringify(body),
        signal: params.signal,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new LLMError(`Could not reach LLM endpoint ${url}: ${cause}`);
    }
  };

  // One retry on transient errors (DeepSeek server overload, rate limits, 5xx).
  let res = await attempt();
  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    await new Promise((r) => setTimeout(r, 1000));
    if (!params.signal?.aborted) res = await attempt();
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    throw new LLMError(`LLM request failed (HTTP ${res.status}): ${detail}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = json.choices?.[0];
  if (!choice?.message) throw new LLMError(`LLM returned no choices: ${JSON.stringify(json).slice(0, 300)}`);

  // DeepSeek V4 can report server overload instead of answering; retry once.
  if (choice.finish_reason === 'insufficient_system_resource' && !params.signal?.aborted) {
    await new Promise((r) => setTimeout(r, 1000));
    const retryRes = await attempt();
    if (retryRes.ok) {
      const retryJson = (await retryRes.json()) as typeof json;
      const retryChoice = retryJson.choices?.[0];
      if (retryChoice?.message && retryChoice.finish_reason !== 'insufficient_system_resource') {
        const retryMessage = fromOpenAIMessage(retryChoice.message);
        if (retryMessage.toolCalls?.length) params.onToolCalls?.(retryMessage.toolCalls);
        return {
          message: retryMessage,
          finishReason: retryChoice.finish_reason ?? 'stop',
          usage: {
            promptTokens: retryJson.usage?.prompt_tokens,
            completionTokens: retryJson.usage?.completion_tokens,
          },
        };
      }
    }
  }

  const message = fromOpenAIMessage(choice.message);
  if (message.toolCalls?.length) params.onToolCalls?.(message.toolCalls);
  return {
    message,
    finishReason: choice.finish_reason ?? 'stop',
    usage: {
      promptTokens: json.usage?.prompt_tokens,
      completionTokens: json.usage?.completion_tokens,
    },
  };
}

export { parseJsonArgs };
