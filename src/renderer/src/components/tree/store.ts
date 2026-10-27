import { create } from 'zustand';
import { toast } from '../../lib/actions';
import { confirmDialog } from '../../lib/dialog';
import { invalidateIndex } from '../../lib/editor/fileIndex';
import { H } from '../../lib/legacy';
import { refreshDiffs } from '../editor/host';
import { activeFile } from '../workspace/layoutStore';

export type View = 'files' | 'changes' | 'find';

export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir';
}
export interface Change {
  path: string;
  status: string;
  orig?: string;
}
export interface Commit {
  sha: string;
  short: string;
  author: string;
  time: number;
  refs: string[];
  subject: string;
}
export interface Git {
  isRepo: boolean;
  /** rel path -> status code ('dir/' keys mark folders with changes) */
  status: Record<string, string>;
  staged: Change[];
  unstaged: Change[];
  log: Commit[];
  stat: { add: number; del: number };
}

interface TreeState {
  view: View;
  visible: boolean;
  side: 'left' | 'right';
  width: string | null;
  root: string | null;
  expanded: Record<string, Set<string>>;
  dirs: Record<string, Entry[]>;
  git: Record<string, Git>;
  /** sha -> files, null while loading */
  commitFiles: Record<string, Change[] | null>;
  openCommits: Set<string>;
  collapsedSecs: Set<string>;
  drafts: Record<string, string>;
  /** multi-selected Source rows: `${mode}\0${abs}` */
  selected: Set<string>;
  anchor: string | null;
  /** bumped when the active file / theme changes: rows re-read them */
  tick: number;
  /** bumped to scroll the Files view to `revealPath` */
  revealTick: number;
  revealPath: string | null;
}

export const useTree = create<TreeState>(() => ({
  view: 'files',
  visible: true,
  side: 'right',
  width: null,
  root: null,
  expanded: {},
  dirs: {},
  git: {},
  commitFiles: {},
  openCommits: new Set(),
  collapsedSecs: new Set(['commits']),
  drafts: {},
  selected: new Set(),
  anchor: null,
  tick: 0,
  revealTick: 0,
  revealPath: null,
}));

const get = useTree.getState;
const set = useTree.setState;
const sep = '/';
const dirname = (p: string) => p.slice(0, p.lastIndexOf(sep)) || sep;
export const baseName = (p: string) => p.split(sep).pop() as string;
export const relTo = (root: string | null, p: string) =>
  root && p.startsWith(root + sep) ? p.slice(root.length + 1) : p;
export const selKey = (mode: string, abs: string) => `${mode}\0${abs}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------- layout / view

export function initTree(ui: {
  treeSide?: 'left' | 'right';
  treeWidth?: string;
  treeView?: View;
  treeHidden?: boolean;
  expanded?: Record<string, string[]>;
}) {
  const expanded: Record<string, Set<string>> = {};
  for (const [r, list] of Object.entries(ui.expanded || {})) expanded[r] = new Set(list);
  set({
    side: ui.treeSide === 'left' ? 'left' : 'right',
    width: ui.treeWidth || null,
    view: ui.treeView || 'files',
    visible: !ui.treeHidden,
    expanded,
  });
}

export function setView(view: View, persist = true) {
  set({ view });
  if (persist) H.saveUi({ treeView: view });
}

export function toggleTree(forceShow?: boolean) {
  const visible = forceShow ? true : !get().visible;
  set({ visible });
  H.saveUi({ treeHidden: !visible });
}

export function setSide(side: 'left' | 'right') {
  set({ side });
  H.saveUi({ treeSide: side });
}

export const moveTreeSide = () => setSide(get().side === 'left' ? 'right' : 'left');

export function setWidth(width: string) {
  set({ width });
  H.saveUi({ treeWidth: width });
}

export function showView(view: View) {
  toggleTree(true);
  setView(view);
}

/** The active file / theme changed. */
export const touch = () => set((s) => ({ tick: s.tick + 1 }));

// ---------------------------------------------------------------- files

async function listDir(dir: string, force = false) {
  if (!force && get().dirs[dir]) return;
  let ents: Entry[] = [];
  try {
    ents = await H.list(dir);
  } catch {
    ents = [];
  }
  set((s) => ({ dirs: { ...s.dirs, [dir]: ents } }));
}

/** Lists the root and every expanded folder under it that isn't cached yet. */
async function loadExpanded(root: string) {
  const exp = get().expanded[root];
  const walk = async (dir: string) => {
    await listDir(dir);
    for (const e of get().dirs[dir] || []) if (e.type === 'dir' && exp?.has(e.path)) await walk(e.path);
  };
  await walk(root);
}

export async function toggleDir(path: string) {
  const { root } = get();
  if (!root) return;
  const exp = new Set(get().expanded[root]);
  if (!exp.delete(path)) exp.add(path);
  set((s) => ({ expanded: { ...s.expanded, [root]: exp } }));
  await loadExpanded(root);
  const saved: Record<string, string[]> = {};
  for (const [r, s] of Object.entries(get().expanded)) saved[r] = [...s].slice(0, 200);
  H.saveUi({ expanded: saved });
}

export async function revealInTree(path: string) {
  const { root } = get();
  if (!path || !root || !path.startsWith(root + sep)) return touch();
  const exp = new Set(get().expanded[root]);
  let d = dirname(path);
  let changed = false;
  while (d.length > root.length) {
    if (!exp.has(d)) {
      exp.add(d);
      changed = true;
    }
    d = dirname(d);
  }
  if (changed) {
    set((s) => ({ expanded: { ...s.expanded, [root]: exp } }));
    await loadExpanded(root);
  }
  set((s) => ({ tick: s.tick + 1, revealPath: path, revealTick: s.revealTick + 1 }));
}

export function setRoot(root: string | null) {
  set((s) => {
    const git = { ...s.git };
    if (root) delete git[root];
    return { root, git, selected: new Set(), anchor: null };
  });
  if (!root) return;
  refreshGit();
  loadExpanded(root).then(() => {
    const open = activeFile();
    if (open) revealInTree(open);
  });
}

export function forgetRoot(root: string) {
  set((s) => {
    const expanded = { ...s.expanded };
    delete expanded[root];
    return { expanded };
  });
}

// ---------------------------------------------------------------- git

let gitTimer: ReturnType<typeof setTimeout> | undefined;
export function refreshGit() {
  clearTimeout(gitTimer);
  gitTimer = setTimeout(async () => {
    const r = get().root;
    if (!r) return;
    const [isRepo, status, changes, log, stat] = await Promise.all([
      H.gitIsRepo(r).catch(() => true),
      H.gitStatus(r).catch(() => ({})),
      H.gitChanges(r).catch(() => ({ staged: [], unstaged: [] })),
      H.gitLog(r).catch(() => []),
      H.gitDiffStat(r).catch(() => ({ add: 0, del: 0 })),
    ]);
    const git: Git = { isRepo, status, staged: changes.staged, unstaged: changes.unstaged, log, stat };
    set((s) => {
      const live = new Set<string>();
      for (const f of git.staged) live.add(selKey('s', r + sep + f.path));
      for (const f of git.unstaged) live.add(selKey('w', r + sep + f.path));
      return {
        git: { ...s.git, [r]: git },
        selected: new Set([...s.selected].filter((k) => live.has(k))),
        anchor: s.anchor && live.has(s.anchor) ? s.anchor : null,
      };
    });
    if (r === get().root) refreshDiffs(r);
  }, 200);
}

H.onFsChanged(async (r: string, paths: string[], gitChanged: boolean) => {
  const dirs = new Set<string>();
  let structural = false;
  for (const p of paths) {
    dirs.add(dirname(p));
    if (!get().dirs[dirname(p)]?.some((e) => e.path === p)) structural = true;
  }
  for (const d of dirs) if (get().dirs[d]) await listDir(d, true);
  if (structural) invalidateIndex(r);
  if (r === get().root) refreshGit();
  else if (gitChanged)
    set((s) => {
      const git = { ...s.git };
      delete git[r];
      return { git };
    });
});

export function setDraft(root: string, text: string) {
  set((s) => ({ drafts: { ...s.drafts, [root]: text } }));
}

export async function commit() {
  const { root, drafts } = get();
  if (!root) return;
  try {
    await H.gitCommit(root, drafts[root] || '');
    setDraft(root, '');
  } catch (e) {
    toast(`Commit failed: ${errMsg(e)}`);
  }
  refreshGit();
}

/** Repo-relative paths (renames include their old path) for these rows. */
export function pathsOf(rows: { abs: string; orig?: string }[]): string[] {
  const { root } = get();
  const out = new Set<string>();
  for (const r of rows) {
    out.add(relTo(root, r.abs));
    if (r.orig) out.add(r.orig);
  }
  return [...out];
}

export async function applyGit(act: 'stage' | 'unstage' | 'discard', paths: string[]) {
  const { root } = get();
  if (!paths.length || !root) return;
  try {
    if (act === 'discard') {
      const what = paths.length === 1 ? `changes to ${baseName(paths[0])}` : `changes to ${paths.length} files`;
      if (
        !(await confirmDialog({
          title: 'Discard changes',
          message: `Discard ${what}? This can't be undone.`,
          confirmLabel: 'Discard',
          danger: true,
        }))
      )
        return;
      await H.gitDiscard(root, paths);
    } else await (act === 'stage' ? H.gitStage : H.gitUnstage)(root, paths);
  } catch (e) {
    toast(`${act === 'discard' ? 'Discard' : act === 'stage' ? 'Stage' : 'Unstage'} failed: ${errMsg(e)}`);
  }
  refreshGit();
}

export function toggleSection(id: string) {
  set((s) => {
    const collapsedSecs = new Set(s.collapsedSecs);
    if (!collapsedSecs.delete(id)) collapsedSecs.add(id);
    return { collapsedSecs };
  });
}

export function setSelection(selected: Set<string>, anchor: string | null) {
  set({ selected, anchor });
}

export async function toggleCommit(sha: string) {
  const { root, openCommits } = get();
  const open = new Set(openCommits);
  if (open.delete(sha)) return set({ openCommits: open });
  open.add(sha);
  set({ openCommits: open });
  if (get().commitFiles[sha] !== undefined || !root) return;
  set((s) => ({ commitFiles: { ...s.commitFiles, [sha]: null } }));
  const files: Change[] = await H.gitCommitFiles(root, sha).catch(() => []);
  set((s) => ({ commitFiles: { ...s.commitFiles, [sha]: files } }));
}

/** What editor.js calls into. */
export const harborTree = {
  setRoot,
  refreshGit,
  revealInTree,
  markActive: touch,
  forgetRoot,
  changes: (r: string) => {
    const g = get().git[r];
    return g ? { staged: g.staged, unstaged: g.unstaged } : undefined;
  },
  commitFiles: (sha: string) => get().commitFiles[sha] || [],
};
