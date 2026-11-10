// Renderer cache of each worktree's local review state (docs/local-review-plan.md), refetched on `lr:changed`.
// Shared by the Review rail view (T4) and the branch diff zones (T5).
import { useEffect } from 'react';
import { create } from 'zustand';
import type { LocalReviewState } from '../../../../shared/types';
import { H } from '../../lib/tawny';

const store = create<{ by: Record<string, LocalReviewState | undefined> }>(() => ({ by: {} }));
const inflight = new Map<string, Promise<LocalReviewState>>();

/** Fetch (or refetch) `dir`'s state into the cache. */
export function loadLocalReview(dir: string): Promise<LocalReviewState> {
  let p = inflight.get(dir);
  if (!p) {
    p = H.lrState(dir).finally(() => inflight.delete(dir));
    inflight.set(dir, p);
    p.then((s) => store.setState((st) => ({ by: { ...st.by, [dir]: s } }))).catch(() => {});
  }
  return p;
}

/** Cached state, without subscribing (for non-React callers such as view-zone sources). */
export const localReviewOf = (dir: string) => store.getState().by[dir];

/** Call `fn` whenever `dir`'s cached state changes. Returns an unsubscribe. */
export function subscribeLocalReview(dir: string, fn: () => void) {
  return store.subscribe((s, prev) => {
    if (s.by[dir] !== prev.by[dir]) fn();
  });
}

/** React hook: `dir`'s state, loading it on first use. */
export function useLocalReview(dir: string | undefined) {
  const s = store((st) => (dir ? st.by[dir] : undefined));
  useEffect(() => {
    if (dir && !store.getState().by[dir]) loadLocalReview(dir);
  }, [dir]);
  return s;
}

H.onLrChanged((dir) => {
  if (store.getState().by[dir]) loadLocalReview(dir);
});
