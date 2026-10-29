import { CircleQuestionMarkIcon } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { Badge } from './ui/badge';
import { Spinner as BaseSpinner } from './ui/spinner';

const DOT = {
  idle: 'bg-[var(--idle)]',
  none: 'border-[1.5px] border-[var(--faint)] bg-transparent',
} as const;

/** waiting = pulsing attention dot, idle = filled, none = hollow */
export function StatusDot({ state, size = 'md' }: { state: keyof typeof DOT | 'waiting'; size?: 'md' | 'sm' }) {
  if (state === 'waiting') {
    return (
      <CircleQuestionMarkIcon
        className={`${size === 'sm' ? 'size-3' : 'size-3.5'} shrink-0 animate-pulse text-[var(--wait)]`}
      />
    );
  }
  const px = state === 'none' || size === 'sm' ? 'size-1.5' : 'size-[7px]';
  return <Badge className={`${px} min-w-0 rounded-full border p-0 ${DOT[state]}`} />;
}

export function Spinner({ size = 'md' }: { size?: 'md' | 'sm' }) {
  return <BaseSpinner className={`${size === 'sm' ? 'size-3' : 'size-3.5'} text-[var(--work)]`} />;
}

/** Status dot / spinner shared by workspace and session rows. */
export function Indicator({
  waiting,
  working,
  any,
  size,
}: {
  waiting: boolean;
  working: boolean;
  any: boolean;
  size?: 'md' | 'sm';
}) {
  if (waiting) return <StatusDot state="waiting" size={size} />;
  if (working) return <Spinner size={size} />;
  return <StatusDot state={any ? 'idle' : 'none'} size={size} />;
}

export function SessionIndicator({ s }: { s: Session }) {
  if (s.kind === 'terminal') return <span className="tglyph">&gt;_</span>;
  return <Indicator waiting={s.waiting} working={s.working} any size="sm" />;
}
