import { CircleQuestionMarkIcon } from 'lucide-react';
import type { Session } from '../../../shared/types';
import { useStore } from '../store';
import { Badge } from './ui/badge';
import { Spinner as BaseSpinner } from './ui/spinner';

const HOLLOW = 'border-[1.5px] border-[var(--faint)] bg-transparent';
const DOT = {
  idle: HOLLOW,
  none: HOLLOW,
} as const;

/** waiting = pulsing question icon, idle/none = hollow */
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

/** finished while you weren't looking */
export function UnseenMark({ size = 'md' }: { size?: 'md' | 'sm' }) {
  return (
    <span className={`font-bold leading-none text-[var(--wait)] ${size === 'sm' ? 'text-[10px]' : 'text-[12px]'}`}>
      !
    </span>
  );
}

export function Spinner({ size = 'md' }: { size?: 'md' | 'sm' }) {
  return <BaseSpinner className={`${size === 'sm' ? 'size-3' : 'size-3.5'} text-[var(--work)]`} />;
}

/** Status dot / spinner shared by workspace and session rows. */
export function Indicator({
  waiting,
  working,
  unseen = false,
  any,
  size,
}: {
  waiting: boolean;
  working: boolean;
  unseen?: boolean;
  any: boolean;
  size?: 'md' | 'sm';
}) {
  if (waiting) return <StatusDot state="waiting" size={size} />;
  if (unseen) return <UnseenMark size={size} />;
  if (working) return <Spinner size={size} />;
  return <StatusDot state={any ? 'idle' : 'none'} size={size} />;
}

export function SessionIndicator({ s }: { s: Session }) {
  const unseen = useStore((st) => st.unseen.has(s.id));
  if (s.kind === 'terminal') return <span className="tglyph">&gt;_</span>;
  return <Indicator waiting={s.waiting} working={s.working} unseen={unseen} any size="sm" />;
}
