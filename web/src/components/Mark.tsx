import { initials, tint } from '../format';
import { cn } from '@/lib/utils';

const SIZES = {
  sm: 'size-6 rounded-[7px] text-[10.5px]',
  md: 'size-8 rounded-[10px] text-xs',
  lg: 'size-10 rounded-xl text-sm',
} as const;

/**
 * Agent monogram. A muted tint of the agent's own colour, so a roster of
 * agents stays scannable without turning into a row of candy tiles.
 */
export function Mark({
  name,
  color,
  size = 'md',
}: {
  name: string;
  color: string;
  size?: keyof typeof SIZES;
}) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center border font-semibold tracking-wide select-none',
        SIZES[size],
      )}
      style={{
        background: tint(color, 0.16),
        borderColor: tint(color, 0.45),
        color,
      }}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}
