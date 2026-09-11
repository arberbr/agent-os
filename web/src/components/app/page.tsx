import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * Page chrome — one header pattern for every screen: title, one-line
 * description, right-aligned actions.
 */
export function Page({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'px-4 py-6 sm:px-6 md:px-8 md:py-8',
        'max-sm:[padding-bottom:max(4rem,env(safe-area-inset-bottom))]',
        className,
      )}
      {...props}
    />
  );
}

export function PageHeader({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <header className={cn('mb-6 flex flex-wrap items-end justify-between gap-6', className)} {...props} />;
}

export function PageHeadMain({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0', className)} {...props} />;
}

export function PageTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h1 className={cn('text-[26px] tracking-tight', className)} {...props} />;
}

export function PageDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('mt-2 max-w-[58ch] text-sm text-muted-foreground', className)} {...props} />;
}

export function PageActions({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-wrap items-center gap-2.5 pb-0.5', className)} {...props} />;
}
