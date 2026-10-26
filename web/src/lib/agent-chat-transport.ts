import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { createUIMessageStream } from 'ai';
import { UNAUTHORIZED_EVENT } from '@/api';
import type { RunEvent } from '@/types';

/**
 * Custom AI SDK transport for the Agents OS run endpoint.
 *
 * The server streams its own SSE dialect (`start` / `step` / `message` /
 * `done` / `error` events) from POST /api/agents/:id/run. This transport
 * adapts that dialect into the AI SDK data stream protocol so `useChat`
 * can drive the chat surface:
 *
 *   - tool_call / tool_result steps become `tool-input-*` / `tool-output-*`
 *     chunks (rendered inline by the AI Elements <Tool> component),
 *   - every step is additionally mirrored as a typed `data-step` part so the
 *     activity rail can render the full trace with timings,
 *   - the closing assistant message becomes a text part,
 *   - run metadata (runId) travels in `data-agent` parts.
 *
 * The run id of the first turn is also the *session*: it is sent back with
 * every later message, so the server answers in the same record and replays the
 * transcript to the model — one ongoing conversation instead of one run per
 * message. `startNewSession()` forgets it, which is what "New session" does.
 *
 * Errors are intentionally NOT swallowed: when the run fails or the request
 * is aborted, the stream rejects and the AI SDK converts it into the proper
 * chat error state (or a clean stop on abort).
 */

/** Payload of `data-agent` parts on assistant messages. */
export interface AgentDataPart {
  kind: 'start' | 'done';
  runId: string;
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export class AgentChatTransport implements ChatTransport<UIMessage> {
  /** Id of the session this conversation lives in; null until the first turn. */
  private sessionId: string | null = null;

  constructor(private readonly agentId: string) {}

  /** End the conversation: the next message opens a fresh session. */
  startNewSession(): void {
    this.sessionId = null;
  }

  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UIMessage>['sendMessages']>[0]): Promise<ReadableStream<UIMessageChunk>> {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    const input = lastUser ? messageText(lastUser) : '';
    const sessionId = this.sessionId;

    return createUIMessageStream({
      execute: ({ writer }) => this.streamRun(input, sessionId, writer, abortSignal),
      // The SDK masks errors as "An error occurred." by default, which is meant
      // for server-side streams. This one runs in the browser and only rethrows
      // what our own API already sent, so keep the real message for the chat.
      onError: (error) => (error instanceof Error ? error.message : String(error)),
    });
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }

  private async streamRun(
    input: string,
    sessionId: string | null,
    writer: { write: (chunk: UIMessageChunk) => void },
    abortSignal: AbortSignal | undefined,
  ): Promise<void> {
    const res = await fetch(`/api/agents/${this.agentId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, ...(sessionId ? { sessionId } : {}) }),
      signal: abortSignal,
    });
    if (!res.ok) {
      // An expired session must send the console back to the login screen
      // instead of surfacing as a failed turn in the chat.
      if (res.status === 401) window.dispatchEvent(new window.Event(UNAUTHORIZED_EVENT));
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!res.body) throw new Error('No response stream.');

    writer.write({ type: 'start' });

    // Tool calls arrive as tool_call steps and their results as tool_result
    // steps, paired by tool name (LIFO per name handles nesting/delegation).
    const pendingCalls = new Map<string, string[]>();
    let toolCounter = 0;
    let textCounter = 0;

    const nextToolId = () => `tool-${toolCounter++}`;

    await this.readEvents(res.body, (event: RunEvent) => {
      switch (event.type) {
        case 'start':
          // The server owns session identity: adopt whatever id it answered
          // with so the next message continues this conversation.
          this.sessionId = event.runId;
          writer.write({ type: 'data-agent', data: { kind: 'start', runId: event.runId } });
          break;

        case 'step': {
          const step = event.step;
          writer.write({ type: 'data-step', data: step });
          if (step.kind === 'tool_call' && step.toolName) {
            const toolCallId = nextToolId();
            pendingCalls.set(step.toolName, [...(pendingCalls.get(step.toolName) ?? []), toolCallId]);
            writer.write({ type: 'tool-input-start', toolCallId, toolName: step.toolName });
            writer.write({
              type: 'tool-input-available',
              toolCallId,
              toolName: step.toolName,
              input: step.args,
            });
          } else if (step.kind === 'tool_result' && step.toolName) {
            const stack = pendingCalls.get(step.toolName);
            const toolCallId = stack && stack.length > 0 ? stack.pop()! : nextToolId();
            if (step.error) {
              writer.write({ type: 'tool-output-error', toolCallId, errorText: step.error });
            } else {
              writer.write({
                type: 'tool-output-available',
                toolCallId,
                output: step.result ?? '',
              });
            }
          }
          break;
        }

        case 'message': {
          // The local user message is already in the chat; only the
          // assistant's reply needs to become a streamed text part.
          if (event.message.role !== 'assistant') break;
          const content = event.message.content ?? '';
          if (!content.trim()) break;
          const textId = `text-${textCounter++}`;
          writer.write({ type: 'text-start', id: textId });
          writer.write({ type: 'text-delta', id: textId, delta: content });
          writer.write({ type: 'text-end', id: textId });
          break;
        }

        case 'done':
          writer.write({ type: 'data-agent', data: { kind: 'done', runId: event.runId } });
          writer.write({ type: 'finish', finishReason: 'stop' });
          break;

        case 'error':
          // Let the rejection surface as a chat error state; the AI SDK
          // converts it into the `error` field on useChat.
          throw new Error(event.error);
      }
    });
  }

  /** Consumes the server's SSE frames (events separated by blank lines). */
  private async readEvents(
    body: ReadableStream<Uint8Array>,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of chunk.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              onEvent(JSON.parse(line.slice(6)) as RunEvent);
            } catch {
              // Ignore malformed frames; the server owns the protocol.
            }
          }
        }
      }
    }
  }
}
