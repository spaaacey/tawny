// "Viewed" marks of changed files, keyed by an identity string (PR: the worktree path, or `<path>:<sha>` for a commit;
// local review: its own identity) and persisted in one UI-state field.
import { create } from 'zustand';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';

export interface ViewedStore {
  /** React hook: the viewed paths of `id` */
  use: (id: string) => string[] | undefined;
  set: (id: string, path: string, on: boolean) => void;
  /** drop the marks of `paths` (e.g. files changed by a new head) */
  clear: (id: string, paths: string[]) => void;
}

/** A viewed store persisted as `ui[uiField]` (`Record<identity, path[]>`). Call once per field, at module level. */
export function createViewedStore(uiField: string): ViewedStore {
  const read = (ui: Record<string, unknown>) => (ui[uiField] as Record<string, string[]>) || {};
  const store = create<{ by: Record<string, string[]> }>(() => ({ by: read(useStore.getState().app.ui) }));
  // modules load before the initial state IPC completes: hydrate once that state arrives
  useStore.subscribe((state, previous) => {
    if (state.ready && !previous.ready) store.setState({ by: read(state.app.ui) });
  });
  const save = (id: string, next: string[]) => {
    const by = { ...store.getState().by, [id]: next };
    store.setState({ by });
    H.saveUi({ [uiField]: by });
  };
  return {
    use: (id) => store((s) => s.by[id]),
    set: (id, path, on) => {
      const cur = store.getState().by[id] || [];
      save(id, on ? [...new Set([...cur, path])] : cur.filter((p) => p !== path));
    },
    clear: (id, paths) => {
      const cur = store.getState().by[id] || [];
      const next = cur.filter((p) => !paths.includes(p));
      if (next.length !== cur.length) save(id, next);
    },
  };
}
