import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode };

export interface DialogProps extends Parts {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface DialogContentProps extends Parts {
  /** sm ~420px, md ~512px, lg ~600px */
  size?: 'sm' | 'md' | 'lg';
  /** center of the window, or near the top (palettes) */
  placement?: 'center' | 'top';
  /** default true; false = no inner padding/gap (content brings its own layout) */
  padded?: boolean;
  /** show a close (x) button; default false */
  closeButton?: boolean;
}

export interface DialogApi {
  Dialog: ComponentType<DialogProps>;
  DialogContent: ComponentType<DialogContentProps>;
  DialogHeader: ComponentType<Parts>;
  /** hidden = screen-reader-only title */
  DialogTitle: ComponentType<Parts & { hidden?: boolean }>;
  DialogFooter: ComponentType<Parts>;
}
