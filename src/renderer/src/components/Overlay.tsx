import type { ReactNode } from 'react';
import { useStore } from '../store';
import { Dialog, DialogContent, DialogTitle } from '../ui';

/** Top-placed dialog shell for bare overlays (e.g. SendBox); the content brings its own padding and layout. */
export function Backdrop({ children }: { children: ReactNode }) {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent size="lg" placement="top" padded={false}>
        <DialogTitle hidden>Dialog</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
