import type { AlertDialogApi } from '../../../contract/alert-dialog';
import * as A from '../alert-dialog';

export const AlertDialog: AlertDialogApi['AlertDialog'] = A.AlertDialog;
export const AlertDialogContent: AlertDialogApi['AlertDialogContent'] = A.AlertDialogContent;
export const AlertDialogHeader: AlertDialogApi['AlertDialogHeader'] = A.AlertDialogHeader;
export const AlertDialogFooter: AlertDialogApi['AlertDialogFooter'] = A.AlertDialogFooter;
export const AlertDialogTitle: AlertDialogApi['AlertDialogTitle'] = A.AlertDialogTitle;
export const AlertDialogDescription: AlertDialogApi['AlertDialogDescription'] = A.AlertDialogDescription;
export const AlertDialogCancel: AlertDialogApi['AlertDialogCancel'] = A.AlertDialogCancel;
export const AlertDialogAction: AlertDialogApi['AlertDialogAction'] = ({ variant = 'primary', ...props }) => (
  <A.AlertDialogAction variant={variant === 'danger' ? 'destructive' : 'default'} {...props} />
);
