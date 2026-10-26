import type { ReactNode } from 'react';
import { useStore } from '../store';

/** Full-window backdrop; a mousedown on the backdrop itself closes the overlay. */
export function Backdrop({ children }: { children: ReactNode }) {
  const close = useStore((s) => s.closeOverlay);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {children}
    </div>
  );
}
