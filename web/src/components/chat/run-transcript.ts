import type { DynamicToolUIPart, UIMessage } from 'ai';
import type { ChatMessage } from '@/types';

/**
 * Rebuild the chat view of a stored session.
 *
 * The run screen renders the same conversation components as the live chat, so
 * a session looks the same whether it is being written in the composer or read
 * back from history. Two things differ from the wire format the transport
 * produces:
 *
 *   - tool calls are separate assistant/tool messages in the store, and are
 *     re-paired here into the `dynamic-tool` parts the transcript expects;
 *   - results stay out of the conversation (the Activity rail is the trace
 *     surface), so each call renders as one compact chip.
 */

type StoredToolCall = { id: string; name: string; arguments: string };

/** How the runtime writes a failed tool call into the transcript (runAgent.ts). */
const TOOL_ERROR_PREFIXES = ['Tool error:', 'Unknown tool', 'Invalid arguments'];

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

function toolResult(messages: ChatMessage[], from: number, toolCallId: string): ChatMessage | undefined {
  // Results for one assistant message are stored directly after it.
  for (let i = from + 1; i < messages.length; i++) {
    const candidate = messages[i];
    if (!candidate || candidate.role !== 'tool') break;
    if (candidate.toolCallId === toolCallId) return candidate;
  }
  return undefined;
}

function toolPart(call: StoredToolCall, result: ChatMessage | undefined): DynamicToolUIPart {
  const input = parseArguments(call.arguments);
  const content = result?.content ?? '';
  const base = { type: 'dynamic-tool', toolName: call.name, toolCallId: call.id } as const;

  return TOOL_ERROR_PREFIXES.some((prefix) => content.startsWith(prefix))
    ? { ...base, state: 'output-error', input, errorText: content }
    : { ...base, state: 'output-available', input, output: content };
}

/** The conversation of a stored session, as the chat surface renders it. */
export function runTranscript(messages: ChatMessage[]): UIMessage[] {
  const transcript: UIMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    // The system prompt is not part of the conversation, and tool messages are
    // folded into the assistant turn that called them.
    if (!message || message.role === 'system' || message.role === 'tool') continue;

    if (message.role === 'user') {
      const text = message.content?.trim();
      if (text) transcript.push({ id: `user-${i}`, role: 'user', parts: [{ type: 'text', text }] });
      continue;
    }

    const parts: UIMessage['parts'] = (message.toolCalls ?? []).map((call) =>
      toolPart(call, toolResult(messages, i, call.id)),
    );
    const text = message.content?.trim();
    if (text) parts.push({ type: 'text', text });
    if (parts.length > 0) transcript.push({ id: `assistant-${i}`, role: 'assistant', parts });
  }

  return transcript;
}
