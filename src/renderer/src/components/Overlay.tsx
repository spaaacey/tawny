import type { ReactNode } from 'react';
import { DialogContent } from './ui/dialog';

/** Dialog content pinned near the top (palettes, overlays); children bring their own padding and layout. */
export function TopDialogContent({ children }: { children: ReactNode }) {
  return (
    <DialogContent
      showCloseButton={false}
      aria-describedby={undefined}
      className="top-[14vh] translate-y-0 gap-0 overflow-hidden rounded-xl border-(--line) p-0 sm:max-w-[600px]"
    >
      {children}
    </DialogContent>
  );
}
