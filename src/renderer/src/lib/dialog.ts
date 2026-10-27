import { create } from 'zustand';

export interface DialogOpts {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface Pending extends DialogOpts {
  /** alert-style: a single OK button */
  alert?: boolean;
  resolve: (ok: boolean) => void;
}

interface DialogState {
  current: Pending | null;
  queue: Pending[];
}

export const useDialog = create<DialogState>(() => ({ current: null, queue: [] }));

function enqueue(p: Pending) {
  useDialog.setState((s) => (s.current ? { queue: [...s.queue, p] } : { current: p }));
}

/** Resolves the open dialog and shows the next queued one. */
export function settleDialog(ok: boolean) {
  const { current, queue } = useDialog.getState();
  if (!current) return;
  useDialog.setState({ current: queue[0] ?? null, queue: queue.slice(1) });
  current.resolve(ok);
}

/** In-app replacement for window.confirm (which blocks the renderer thread and all CDP calls). */
export function confirmDialog(opts: DialogOpts): Promise<boolean> {
  return new Promise((resolve) => enqueue({ ...opts, resolve }));
}

/** In-app replacement for window.alert. */
export function alertDialog(message: string, title?: string): Promise<void> {
  return new Promise((resolve) =>
    enqueue({ title, message, confirmLabel: 'OK', alert: true, resolve: () => resolve() }),
  );
}
