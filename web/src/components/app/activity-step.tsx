import { Icon, type IconName } from '@/components/Icon';
import { formatClock } from '@/format';
import { cn } from '@/lib/utils';
import type { RunStep } from '@/types';

const STEP_ICON: Record<RunStep['kind'], IconName> = {
  llm: 'brain',
  tool_call: 'wrench',
  tool_result: 'file',
  delegate: 'users',
  note: 'info',
};

function stepTone(kind: RunStep['kind']): string {
  if (kind === 'llm') return 'think';
  if (kind === 'tool_call') return 'call';
  if (kind === 'tool_result') return 'result';
  return '';
}

/**
 * ActivityStep — one row of the trace log: kind icon, title line, timing,
 * and the optional args/result detail. `resultLimit` caps the result shown
 * (live runs show more than the compact history view).
 */
export function ActivityStep({ step, resultLimit = 4000 }: { step: RunStep; resultLimit?: number }) {
  const tone = stepTone(step.kind);

  return (
    <div className="log-row border-t border-rule px-4 py-3 first:border-t-0">
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'flex size-6 shrink-0 items-center justify-center rounded-[7px] bg-surface-2 text-muted-foreground',
            tone === 'think' && 'bg-signal-soft text-primary',
            tone === 'call' && 'bg-warning/15 text-warning',
            tone === 'result' && 'bg-success/15 text-success',
          )}
        >
          <Icon name={STEP_ICON[step.kind]} size={12} />
        </span>
        <div className="min-w-0 flex-1">
          {step.kind === 'tool_call' && (
            <div className="text-[12.5px] leading-snug break-words">
              Called <code>{step.toolName}</code>
            </div>
          )}
          {step.kind === 'tool_result' && (
            <div className="text-[12.5px] leading-snug break-words">
              <code>{step.toolName}</code> returned
            </div>
          )}
          {step.kind === 'delegate' && <div className="text-[12.5px] leading-snug break-words">{step.note}</div>}
          {step.kind === 'llm' && <div className="text-[12.5px] leading-snug text-muted-foreground break-words">{step.note}</div>}
          {step.kind === 'note' && <div className="text-[12.5px] leading-snug text-muted-foreground break-words">{step.note}</div>}
          <div className="mt-0.5 font-mono text-[10.5px] text-mute">
            {formatClock(step.at)}
            {step.durationMs != null && ` (${step.durationMs} ms)`}
          </div>
        </div>
      </div>
      {step.kind === 'tool_call' && step.args !== undefined && (
        <pre className="ml-[34px] mt-2 max-h-[200px] overflow-y-auto rounded-[9px] border border-rule bg-inset px-3 py-2.5 text-[11px] text-[#a8ad9f]">
          {JSON.stringify(step.args, null, 1)}
        </pre>
      )}
      {step.kind === 'tool_result' && step.result && (
        <pre className="ml-[34px] mt-2 max-h-[200px] overflow-y-auto rounded-[9px] border border-rule bg-inset px-3 py-2.5 text-[11px] text-[#a8ad9f]">
          {step.result.slice(0, resultLimit)}
        </pre>
      )}
      {step.error && (
        <div className="ml-[34px] mt-2 max-h-[200px] overflow-y-auto rounded-[9px] border border-danger/40 bg-inset px-3 py-2.5 text-[11px] text-[#f2b3ad]">
          {step.error}
        </div>
      )}
    </div>
  );
}
