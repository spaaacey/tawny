import { type DialogOpts, settleDialog, useDialog } from '../lib/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';

export function ConfirmDialog() {
  const cur = useDialog((s) => s.current);
  // remount per dialog so each queued one gets fresh open/focus state
  return cur ? <DialogBody key={cur.message + (cur.title ?? '')} cur={cur} /> : null;
}

function DialogBody({ cur }: { cur: DialogOpts & { alert?: boolean } }) {
  return (
    <AlertDialog open onOpenChange={(open) => !open && settleDialog(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{cur.title ?? 'Confirm'}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto">
            {cur.message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {!cur.alert && (
            <AlertDialogCancel onClick={() => settleDialog(false)}>{cur.cancelLabel ?? 'Cancel'}</AlertDialogCancel>
          )}
          <AlertDialogAction
            variant={cur.danger ? 'destructive' : 'default'}
            autoFocus
            onClick={() => settleDialog(true)}
          >
            {cur.confirmLabel ?? 'OK'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
