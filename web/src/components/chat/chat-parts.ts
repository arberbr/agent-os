import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai';
import type { RunStep } from '@/types';

/** A tool call and/or its result, however the model addressed it. */
export type ToolPart = ToolUIPart | DynamicToolUIPart;

/**
 * Part helpers for the agent conversation. The transport emits three kinds of
 * parts on the assistant message: text (the final reply), tool-* parts (tool
 * calls and results), and data parts (a `data-agent` run marker plus one
 * `data-step` per trace step).
 */
export type AnyPart = UIMessage['parts'][number];

export function isTextPart(part: AnyPart): part is Extract<AnyPart, { type: 'text' }> {
  return part.type === 'text';
}

export function isToolPart(part: AnyPart): part is ToolPart {
  return part.type.startsWith('tool-') || part.type === 'dynamic-tool';
}

export function isDataPart(part: AnyPart): part is Extract<AnyPart, { type: `data-${string}` }> {
  return part.type.startsWith('data-');
}

export function isRunStep(value: unknown): value is RunStep {
  return Boolean(value) && typeof value === 'object' && typeof (value as RunStep).kind === 'string';
}

export interface AgentData {
  kind: 'start' | 'done';
  runId: string;
}

export function isAgentData(value: unknown): value is AgentData {
  return Boolean(value) && typeof value === 'object' && (value as AgentData).kind !== undefined;
}

export function runCompleted(message: UIMessage): boolean {
  return message.parts.some(
    (p) => isDataPart(p) && p.type === 'data-agent' && isAgentData(p.data) && p.data.kind === 'done',
  );
}

export function stepsOf(message: UIMessage | null): RunStep[] {
  if (!message) return [];
  const out: RunStep[] = [];
  for (const part of message.parts) {
    if (isDataPart(part) && part.type === 'data-step' && isRunStep(part.data)) out.push(part.data);
  }
  return out;
}

export function hasText(message: UIMessage | null): boolean {
  return message?.parts.some((p) => isTextPart(p) && p.text.trim().length > 0) ?? false;
}
