import type { ReactNode } from 'react';
import { useStore } from '../store';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

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

/** Top-placed dialog shell for bare overlays (e.g. SendBox); the content brings its own padding and layout. */
export function Backdrop({ children }: { children: ReactNode }) {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <TopDialogContent>
        <DialogTitle className="sr-only">Dialog</DialogTitle>
        {children}
      </TopDialogContent>
    </Dialog>
  );
}
