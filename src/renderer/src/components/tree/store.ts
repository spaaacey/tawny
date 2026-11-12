import { create } from 'zustand';
import { toast } from '../../lib/actions';
import { confirmDialog } from '../../lib/dialog';
import { invalidateIndex } from '../../lib/editor/fileIndex';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { openFile } from '../editor/api';
import { refreshBlame } from '../editor/blame';
import { refreshDiffs } from '../editor/host';
import { activeFile, isZoomed, setZoom } from '../workspace/layoutStore';

export type View = 'files' | 'changes' | 'find' | 'asks' | 'debug' | 'pr' | 'review';

export interface Entry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  ignored?: boolean;
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
  /** last-clicked Files row */
  focused: string | null;
  /** pending inline new file/folder row */
  creating: { dir: string; kind: 'file' | 'dir' } | null;
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
  focused: null,
  creating: null,
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
  const visible = forceShow !== undefined ? forceShow : !get().visible;
  set({ visible });
  H.saveUi({ treeHidden: !visible });
}

let focusPrev: { sidebar: boolean; tree: boolean; zoomed: boolean } | null = null;

/** Full-app focus: zoom the pane and hide both sidebars; toggling again restores them. Not persisted. */
export function toggleFocusMode() {
  const app = useStore.getState();
  if (focusPrev) {
    const prev = focusPrev;
    focusPrev = null;
    useStore.setState({ sidebarHidden: !prev.sidebar });
    set({ visible: prev.tree });
    if (!prev.zoomed) setZoom(false);
    return;
  }
  focusPrev = { sidebar: !app.sidebarHidden, tree: get().visible, zoomed: isZoomed() };
  useStore.setState({ sidebarHidden: true });
  set({ visible: false });
  setZoom(true);
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

export const setFocused = (focused: string | null) => set({ focused });

export async function collapseAll() {
  const { root } = get();
  if (!root) return;
  set((s) => ({ expanded: { ...s.expanded, [root]: new Set() } }));
  const saved: Record<string, string[]> = {};
  for (const [r, s] of Object.entries(get().expanded)) saved[r] = [...s].slice(0, 200);
  H.saveUi({ expanded: saved });
}

async function expandDir(dir: string) {
  const { root } = get();
  if (!root) return;
  const exp = new Set(get().expanded[root]);
  let d = dir;
  while (d.length > root.length) {
    exp.add(d);
    d = dirname(d);
  }
  set((s) => ({ expanded: { ...s.expanded, [root]: exp } }));
  await loadExpanded(root);
  const saved: Record<string, string[]> = {};
  for (const [r, s] of Object.entries(get().expanded)) saved[r] = [...s].slice(0, 200);
  H.saveUi({ expanded: saved });
}

/** Start an inline create row. `from`: row path (folder → inside, file → its parent); omitted → focused row, else root. */
export async function startCreate(kind: 'file' | 'dir', from?: { path: string; type: 'file' | 'dir' } | null) {
  const { root, focused } = get();
  if (!root) return;
  let dir = root;
  if (from) dir = from.type === 'dir' ? from.path : dirname(from.path);
  else if (focused?.startsWith(root + sep)) {
    const isDir = Object.values(get().dirs).some((l) => l.some((e) => e.path === focused && e.type === 'dir'));
    dir = isDir ? focused : dirname(focused);
  }
  if (dir !== root) await expandDir(dir);
  else await listDir(root);
  set({ creating: { dir, kind } });
}

/** Paste files from the system clipboard into `dir`, then refresh. */
export async function pasteInto(dir: string) {
  const { root } = get();
  if (!root) return;
  try {
    const made = await H.pasteFiles(dir);
    if (!made.length) return;
    await expandDir(dir);
    await listDir(dir, true);
    invalidateIndex(root);
    set((s) => ({ focused: made[0], tick: s.tick + 1, revealPath: made[0], revealTick: s.revealTick + 1 }));
    refreshGit();
  } catch (e) {
    console.error('paste failed', e);
  }
}

/** Target dir for a paste: folder row → itself, file row → its parent, none → root. */
export function pasteDir(from?: { path: string; type: 'file' | 'dir' } | null): string {
  const { root, focused, dirs } = get();
  if (from) return from.type === 'dir' ? from.path : dirname(from.path);
  if (focused?.startsWith(`${root}${sep}`)) {
    const isDir = Object.values(dirs).some((l) => l.some((e) => e.path === focused && e.type === 'dir'));
    return isDir ? focused : dirname(focused);
  }
  return root ?? '';
}

export const cancelCreate = () => set({ creating: null });

/** Returns an error message to show inline, or null on success. */
export function validateName(name: string, dir: string): string | null {
  if (!name.trim()) return 'Name required';
  if (name.startsWith('/') || name.endsWith('/')) return 'Name cannot start or end with a slash';
  const segs = name.split('/');
  if (segs.some((s) => !s.trim())) return 'Invalid name';
  if (segs.some((s) => s === '.' || s === '..')) return 'Name cannot contain "." or ".." segments';
  if (get().dirs[dir]?.some((e) => e.name === segs[0] && (segs.length > 1 ? e.type === 'file' : true)))
    return `A file or folder named "${segs[0]}" already exists`;
  return null;
}

export async function commitCreate(name: string): Promise<string | null> {
  const { creating, root } = get();
  if (!creating || !root) return null;
  name = name.trim();
  const err = validateName(name, creating.dir);
  if (err) return err;
  const abs = `${creating.dir}/${name}`;
  try {
    await H.create(abs, creating.kind);
  } catch (e) {
    return errMsg(e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
  }
  set({ creating: null });
  const parent = creating.kind === 'dir' ? abs : dirname(abs);
  // list every dir from the target down to the new entry's parent
  const chain: string[] = [];
  for (let d = parent; d.length >= creating.dir.length; d = dirname(d)) chain.push(d);
  await listDir(creating.dir, true);
  for (const d of chain.reverse()) if (d !== creating.dir) await listDir(d, true);
  invalidateIndex(root);
  await expandDir(parent);
  if (creating.kind === 'dir') {
    set((s) => ({ focused: abs, tick: s.tick + 1, revealPath: abs, revealTick: s.revealTick + 1 }));
  } else {
    set({ focused: abs });
    await openFile(abs, { pin: true });
  }
  refreshGit();
  return null;
}

export function setRoot(root: string | null) {
  set((s) => {
    const git = { ...s.git };
    if (root) delete git[root];
    return { root, git, selected: new Set(), anchor: null, focused: null, creating: null };
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
    if (r === get().root) {
      refreshDiffs(r);
      refreshBlame(r);
    }
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

export async function undoCommit() {
  const { root, drafts } = get();
  if (!root) return;
  try {
    const msg = await H.gitUndoCommit(root);
    if (!(drafts[root] || '').trim()) setDraft(root, msg);
  } catch (e) {
    toast(`Undo commit failed: ${errMsg(e)}`);
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

/** Expand the Commits section and open `sha` in it. */
export function revealCommit(sha: string) {
  if (get().collapsedSecs.has('commits')) toggleSection('commits');
  if (!get().openCommits.has(sha)) toggleCommit(sha);
}

/** What editor.js calls into. */
export const tawnyTree = {
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
