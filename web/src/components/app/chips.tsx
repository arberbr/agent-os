import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

/**
 * Status chips — the two badge tones the shadcn set does not carry natively:
 * the aqua "signal" chip (teams, live state) and the amber "needs setup" chip.
 */
export function SignalChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={`border-signal-line text-primary ${className ?? ''}`}>
      {children}
    </Badge>
  );
}

export function WarnChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={`border-warning/40 text-warning ${className ?? ''}`}>
      {children}
    </Badge>
  );
}
