import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export type StateTone = 'idle' | 'ok' | 'warn' | 'fail' | 'live';

/**
 * State rail — the strip-board marker: a small dot whose colour carries the
 * status, with a short label. The single way state is drawn in the console.
 */
export function StateRail({
  tone = 'idle',
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: StateTone }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground', className)}
      {...props}
    >
      <i
        aria-hidden="true"
        className={cn(
          'size-[7px] shrink-0 rounded-full bg-mute',
          tone === 'ok' && 'bg-success',
          tone === 'warn' && 'bg-warning',
          tone === 'fail' && 'bg-danger',
          tone === 'live' && 'animate-breathe bg-primary',
        )}
      />
      {children}
    </span>
  );
}
