import { ChevronRight } from 'lucide-react';

/** Disclosure arrow used everywhere (points right; `.open > .chev` / expanded rows rotate it down). */
export function Chevron() {
  return <ChevronRight className="chev" size={14} strokeWidth={1.6} aria-hidden />;
}
