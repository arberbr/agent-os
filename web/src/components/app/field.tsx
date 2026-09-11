import type { ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { Label } from '@/components/ui/label';

/**
 * Field — the standard form block: label above the control, optional hint in
 * the label, error message below the control. Label is always present; the
 * placeholder never doubles as a label.
 */
export function Field({
  label,
  hint,
  htmlFor,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mb-[18px] last:mb-0">
      <Label htmlFor={htmlFor} className="mb-1.5 block w-fit text-[12.5px]">
        {label}
        {hint && (
          <>
            {' '}
            <span className="text-xs font-normal text-mute">{hint}</span>
          </>
        )}
      </Label>
      {children}
      {error && (
        <span
          className="mt-1.5 flex items-center gap-1.5 text-xs text-danger"
          id={htmlFor ? `${htmlFor}-error` : undefined}
          role="alert"
        >
          <Icon name="alert" size={12} /> {error}
        </span>
      )}
    </div>
  );
}
