import type { Session } from '../../../shared/types';
import { Spinner, StatusDot } from '../ui';

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
