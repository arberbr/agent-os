import type { ChatMessage } from '../types.js';

/**
 * Transcript helpers for a continued session.
 *
 * A session is a single `Run` whose transcript keeps growing: each new user
 * message is answered in the same record, and the model receives everything
 * that happened before it. These helpers turn that stored transcript back into
 * the history prefix of the next request.
 */

/**
 * The conversation part of a stored transcript: everything but the system
 * prompt, which is rebuilt per turn (the agent's persona may have changed
 * since the session started).
 */
export function conversationMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => message.role !== 'system').map((message) => ({ ...message }));
}

/**
 * Build the `history` prefix for the next turn of a session.
 *
 * Tool traffic is replayed on purpose — the model should see what it already
 * did instead of re-running work — but only in complete call/result groups: an
 * interrupted turn can leave an assistant message whose tool results never
 * arrived, and providers reject a request that carries a tool call without its
 * answer.
 *
 * The oldest turns are dropped once the transcript outgrows `maxChars`, so a
 * long conversation degrades to "recent context" instead of failing the
 * request on the provider's context limit.
 */
export function buildHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  return trimToBudget(conversationUnits(conversationMessages(messages)), maxChars).flat();
}

/** Groups that must be replayed together, in order. */
function conversationUnits(messages: ChatMessage[]): ChatMessage[][] {
  const units: ChatMessage[][] = [];

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;

    // An answer with no question: its assistant message was dropped below.
    if (message.role === 'tool') continue;

    const calls = message.role === 'assistant' ? message.toolCalls ?? [] : [];
    if (calls.length === 0) {
      units.push([message]);
      continue;
    }

    const results = new Map<string, ChatMessage>();
    let next = i + 1;
    while (next < messages.length) {
      const result = messages[next];
      if (!result || result.role !== 'tool') break;
      if (result.toolCallId) results.set(result.toolCallId, result);
      next++;
    }

    if (calls.every((call) => results.has(call.id))) {
      units.push([message, ...calls.map((call) => results.get(call.id)!)]);
    } else if ((message.content ?? '').trim()) {
      // Interrupted tool loop: keep the assistant's prose, drop the calls.
      units.push([{ role: 'assistant', content: message.content }]);
    }
    i = next - 1;
  }

  return units;
}

/** Keep the newest units that fit the budget (always at least the last one). */
function trimToBudget(units: ChatMessage[][], maxChars: number): ChatMessage[][] {
  if (!Number.isFinite(maxChars) || maxChars <= 0) return units;

  const kept: ChatMessage[][] = [];
  let used = 0;
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units[i];
    if (!unit) continue;
    const size = unit.reduce((total, message) => total + approximateSize(message), 0);
    if (kept.length > 0 && used + size > maxChars) break;
    kept.unshift(unit);
    used += size;
  }
  return kept;
}

function approximateSize(message: ChatMessage): number {
  const text = (message.content?.length ?? 0) + (message.reasoningContent?.length ?? 0);
  const calls = message.toolCalls?.length ? JSON.stringify(message.toolCalls).length : 0;
  return text + calls;
}
