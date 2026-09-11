import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/Icon';
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

/**
 * EmptyState — the one empty-state composition: an icon medallion, a title,
 * a direction line, and an optional action. Empty screens are invitations
 * to act, never dead ends.
 */
export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon: IconName;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="border-dashed py-12">
      <EmptyMedia variant="icon">
        <Icon name={icon} size={22} />
      </EmptyMedia>
      <EmptyTitle>{title}</EmptyTitle>
      {description && <EmptyDescription>{description}</EmptyDescription>}
      {children}
    </Empty>
  );
}
