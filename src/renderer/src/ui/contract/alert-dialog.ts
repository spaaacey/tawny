import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode };

export interface AlertDialogProps extends Parts {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export interface AlertDialogApi {
  AlertDialog: ComponentType<AlertDialogProps>;
  AlertDialogContent: ComponentType<Parts>;
  AlertDialogHeader: ComponentType<Parts>;
  AlertDialogFooter: ComponentType<Parts>;
  AlertDialogTitle: ComponentType<Parts>;
  AlertDialogDescription: ComponentType<Parts & { className?: string }>;
  /** closes the dialog and calls onClick; variant picks primary or danger styling */
  AlertDialogAction: ComponentType<
    Parts & { variant?: 'primary' | 'danger'; autoFocus?: boolean; onClick?: () => void }
  >;
  AlertDialogCancel: ComponentType<Parts & { onClick?: () => void }>;
}
