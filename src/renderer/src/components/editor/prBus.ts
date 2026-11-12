// Tiny bus: whoever changed a PR's snapshot (PR tab fetch/refresh, a review mutation) tells the open PR diffs and the PR tab.
import { create } from 'zustand';
import type { PrSnapshot } from '../../../../shared/types';

type Listener = (root: string, snap: PrSnapshot) => void;
const listeners = new Set<Listener>();
export const onPrSnapshot = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** `root`'s snapshot changed: open PR diffs redraw their threads, the PR tab re-renders. */
export const prSnapshotChanged: Listener = (root, snap) => {
  for (const l of listeners) l(root, snap);
};

/** Hide every review thread and finding card in PR diffs (session-only toggle in the PR files toolbar). */
export const useHideComments = create<{ hidden: boolean }>(() => ({ hidden: false }));
