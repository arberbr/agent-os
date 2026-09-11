import type { HTMLAttributes } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * Panel — the signature Agents OS surface.
 *
 * "Canvas and surface are different materials, not different greys." Panels
 * are warm stone cards with 16px corners, a soft tinted shadow and a hairline
 * border; the page canvas behind them is darker. The header carries a rule so
 * a titled section reads as a strip on a board, not a floating card.
 */
export function Panel({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <Card
      className={cn('gap-0 overflow-hidden rounded-2xl p-0 shadow-panel', className)}
      {...props}
    />
  );
}

export function PanelHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="panel-header"
      className={cn('flex items-center justify-between gap-4 border-b border-rule px-5 py-4', className)}
      {...props}
    />
  );
}

/** Section title (the global h2 scale: 15px, 600). */
export function PanelTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('min-w-0', className)} {...props} />;
}

/** Quiet note beside the title (counts, emails, one-liners). */
export function PanelNote({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('text-xs text-muted-foreground', className)} {...props} />;
}

export function PanelContent({
  className,
  flush,
  ...props
}: HTMLAttributes<HTMLDivElement> & { flush?: boolean }) {
  return (
    <div
      data-slot="panel-content"
      className={cn(!flush && 'px-5 py-5', className)}
      {...props}
    />
  );
}
