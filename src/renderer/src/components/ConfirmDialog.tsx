import { useEffect, useRef } from 'react';
import { type DialogOpts, settleDialog, useDialog } from '../lib/dialog';

export function ConfirmDialog() {
  const cur = useDialog((s) => s.current);
  // remount per dialog so focus capture/restore runs for each queued one
  return cur ? <DialogBody key={cur.message + (cur.title ?? '')} cur={cur} /> : null;
}

function DialogBody({ cur }: { cur: DialogOpts & { alert?: boolean } }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    okRef.current?.focus();
    return () => {
      if (prev?.isConnected) prev.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        settleDialog(false);
      } else if (e.key === 'Enter') {
        // Enter on the Cancel button activates it natively
        if ((e.target as HTMLElement | null)?.dataset.cancel) return;
        e.preventDefault();
        e.stopPropagation();
        settleDialog(true);
      } else if (e.key === 'Tab') {
        const els = boxRef.current?.querySelectorAll<HTMLElement>('button');
        if (!els?.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        const a = document.activeElement;
        if (!boxRef.current?.contains(a)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && a === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && a === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div
      className="overlay dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settleDialog(false);
      }}
    >
      <div
        className="modal confirm-dialog"
        ref={boxRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={cur.title ?? 'Confirm'}
      >
        {cur.title && <h2>{cur.title}</h2>}
        <div className="confirm-msg">{cur.message}</div>
        <div className="modal-actions">
          {!cur.alert && (
            <button type="button" className="ghost-btn" data-cancel="1" onClick={() => settleDialog(false)}>
              {cur.cancelLabel ?? 'Cancel'}
            </button>
          )}
          <button
            type="button"
            ref={okRef}
            className={`primary-btn${cur.danger ? ' danger-btn' : ''}`}
            onClick={() => settleDialog(true)}
          >
            {cur.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
