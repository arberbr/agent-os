import type { ReactNode } from 'react';
import { Mark } from '@/components/Mark';
import { Badge } from '@/components/ui/badge';
import { plural } from '@/format';
import type { AgentDef } from '@/types';

/**
 * AgentRow — the roster row block: monogram, name/description, and a right
 * side that shows the tool count by default or any caller-provided badges and
 * actions. Wrap it in a <Link className="row"> or a <div className="row">.
 */
export function AgentRow({ agent, side }: { agent: AgentDef; side?: ReactNode }) {
  return (
    <>
      <Mark name={agent.name} color={agent.color} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{agent.name}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-mute">
          {agent.description || 'No description'}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        {side ?? <Badge variant="secondary">{plural(agent.enabledTools.length, 'tool')}</Badge>}
      </div>
    </>
  );
}
