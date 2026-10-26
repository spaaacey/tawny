import type { Session } from '../../../shared/types';

/** Status dot / spinner shared by workspace and session rows. */
export function Indicator({ waiting, working, any }: { waiting: boolean; working: boolean; any: boolean }) {
  if (waiting) return <div className="dot wait" />;
  if (working) return <div className="spin" />;
  return <div className={`dot ${any ? 'idle' : 'none'}`} />;
}

export function SessionIndicator({ s }: { s: Session }) {
  if (s.kind === 'terminal') return <span className="tglyph">&gt;_</span>;
  return <Indicator waiting={s.waiting} working={s.working} any />;
}
