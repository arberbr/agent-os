import { useMemo } from 'react';
import type { UIMessage } from 'ai';
import { Icon, toolIcon } from '@/components/Icon';
import { cn } from '@/lib/utils';
import { isToolPart, type ToolPart } from './chat-parts';

/**
 * One tool call, as a single quiet line: what ran and how it ended.
 *
 * The arguments and the result belong to the Activity rail, which is the
 * trace surface for a run. Keeping them out of the conversation means the
 * transcript stays a conversation instead of a log.
 */

const STATE_LABEL: Record<ToolPart['state'], string> = {
  'approval-requested': 'Awaiting approval',
  'approval-responded': 'Approved',
  'input-available': 'Running',
  'input-streaming': 'Pending',
  'output-available': 'Completed',
  'output-denied': 'Denied',
  'output-error': 'Error',
};

function stateTone(state: ToolPart['state']): string {
  if (state === 'output-available') return 'text-success';
  if (state === 'output-error' || state === 'output-denied') return 'text-danger';
  if (state === 'input-available' || state === 'input-streaming') return 'text-primary';
  return 'text-mute';
}

/** Group the parts of one assistant message by tool call id, in order. */
export function groupToolParts(parts: UIMessage['parts']): Map<string, ToolPart[]> {
  const map = new Map<string, ToolPart[]>();
  for (const part of parts) {
    if (!isToolPart(part)) continue;
    map.set(part.toolCallId, [...(map.get(part.toolCallId) ?? []), part]);
  }
  return map;
}

function toolName(part: ToolPart): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.replace(/^tool-/, '');
}

/** The compact marker drawn in the transcript: name plus how the call ended. */
export function ToolGroup({ parts }: { parts: ToolPart[] }) {
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const name = toolName(first);

  return (
    <div className="flex w-fit items-center gap-2 rounded-md border border-rule bg-surface-2/50 px-2.5 py-1.5">
      <Icon name={toolIcon(name)} size={13} className="text-muted-foreground" />
      <span className="font-mono text-[11.5px] text-foreground">{name}</span>
      <span className={cn('text-[11px]', stateTone(last.state))}>{STATE_LABEL[last.state]}</span>
    </div>
  );
}

export function useToolGroups(message: UIMessage): Map<string, ToolPart[]> {
  return useMemo(() => groupToolParts(message.parts), [message.parts]);
}
