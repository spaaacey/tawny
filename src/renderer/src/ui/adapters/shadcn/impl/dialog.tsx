import { cn } from '@/lib/utils';
import type { DialogApi } from '../../../contract/dialog';
import * as D from '../dialog';

const SIZE = { sm: 'sm:max-w-[420px]', md: 'sm:max-w-lg', lg: 'sm:max-w-[600px]' } as const;

export const Dialog: DialogApi['Dialog'] = D.Dialog;
export const DialogHeader: DialogApi['DialogHeader'] = D.DialogHeader;
export const DialogFooter: DialogApi['DialogFooter'] = D.DialogFooter;
export const DialogTitle: DialogApi['DialogTitle'] = ({ hidden, ...props }) => (
  <D.DialogTitle className={cn(hidden && 'sr-only')} {...props} />
);
export const DialogContent: DialogApi['DialogContent'] = ({
  size = 'md',
  placement = 'center',
  padded = true,
  closeButton = false,
  ...props
}) => (
  <D.DialogContent
    showCloseButton={closeButton}
    aria-describedby={undefined}
    className={cn(
      SIZE[size],
      placement === 'top' && 'top-[14vh] translate-y-0',
      !padded && 'gap-0 overflow-hidden p-0',
    )}
    {...props}
  />
);
