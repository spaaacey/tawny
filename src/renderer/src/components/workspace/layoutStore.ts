// Layout store: the workspace model behind the split-pane UI. Per worktree root, a
// Workspace { pages, at }; each page is a tree of Split { dir, sizes, children } /
// Leaf { id, tabs, active, preview } tab groups. A tab is an agent ('a:<session id>'),
// a file ('f:<path>'), a new-tab launcher ('n:<id>') or a diff ('d:s|w|c:…').
//
// Owns pages, persistence (window.tawny saveUi / revive), session <-> agent-tab
// reconcile, and the tab/page/zoom/focus actions. DOM effects are registered through
// configureLayoutStore() by panes.ts. Model objects (pages, nodes, the workspaces map) are mutated in
// place; `rev` bumps on every committed change and is the
// signal subscribers should re-render on.
//
// The tree ops below (parentOf, prune, normalize, splitGroup, …) are pure functions over
// node objects, exported so a later slice can unit-test them — this project has no test
// runner and step 2 must not add one.
import { create } from 'zustand';
import { stopAgent } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { closeDiff, closeTab, diffInfo, dropDiff, dropPath, preload, tabInfo } from '../editor/api';
import { saveView } from '../editor/host';

export type Dir = 'row' | 'col';
export type Side = 'left' | 'right' | 'top' | 'bottom';
export interface Leaf {
  id: string;
  tabs: string[];
  active: string | null;
  preview?: string | null;
}
export interface Split {
  dir: Dir;
  sizes: number[];
  children: Node[];
}
export type Node = Leaf | Split;
export interface Page {
  id: string;
  name: string;
  color: string;
  tree: Node;
  focus: string | null;
  lastFile: string | null;
  lastAgent: string | null;
  zoom: string | null;
}
export interface Workspace {
  pages: Page[];
  at: number;
}
export interface OpenOpts {
  focus?: boolean;
  preview?: boolean;
  pin?: boolean;
}
/** Where a dragged tab lands; the renderer's Drop adds screen rects to these shapes. */
export type DropTarget =
  | { kind: 'page'; page: number }
  | { kind: 'tab'; g: Leaf; index: number }
  | { kind: 'edge'; g: Leaf; side: Side }
  | { kind: 'center'; g: Leaf };

// biome-ignore lint/suspicious/noExplicitAny: persisted JSON of unknown shape
export type Any = any;

// ------------------------------------------------------------------ state

interface LayoutState {
  /** root -> { pages: [page], at }; page = { id, name, tree, focus, lastFile, lastAgent, zoom } */
  workspaces: Map<string, Workspace>;
  /** active worktree root */
  root: string | null;
  /** file tabs saved before split panes, folded into the first workspace of each root */
  legacy: Record<string, { tabs?: string[] }>;
  /** group a newly started agent should land in */
  expectGroup: string | null;
  /** launcher tab a new agent replaces */
  expectReplace: string | null;
  /** bumped on every committed mutation; subscribers re-render on this */
  rev: number;
}

export const useLayoutStore = create<LayoutState>(() => ({
  workspaces: new Map(),
  root: null,
  legacy: {},
  expectGroup: null,
  expectReplace: null,
  rev: 0,
}));

const S = useLayoutStore.getState;

/** DOM effects installed by panes.ts. */
export interface LayoutFx {
  renderRoot(force?: boolean): void;
  renderPageBar(): void;
  /** focus the newly active tab: terminal, launcher input, or Monaco */
  afterActivate(g: Leaf, key: string): void;
  /** mark a group focused and focus whatever it shows */
  focusGroup(g: Leaf): void;
  /** in-flight mount promise of a group, if any */
  pendingMount(gid: string): Promise<string | null> | null;
  /** on-screen rect of a group's element, if rendered */
  groupRect(gid: string): DOMRect | null;
  /** drop DOM/editors of groups that no longer exist in any worktree's layout */
  gc(): void;
}
const fx: LayoutFx = {
  renderRoot: () => {},
  renderPageBar: () => {},
  afterActivate: () => {},
  focusGroup: () => {},
  pendingMount: () => null,
  groupRect: () => null,
  gc: () => {},
};
export function configureLayoutStore(h: Partial<LayoutFx>) {
  Object.assign(fx, h);
}

/** Publish a model change: bump the revision, persist (debounced), and redraw. */
function commit(opts: { force?: boolean; persist?: boolean } = {}) {
  useLayoutStore.setState((s) => ({ rev: s.rev + 1 }));
  if (opts.persist !== false) persist();
  fx.renderRoot(opts.force);
}

// ------------------------------------------------------------------ tree

let seq = 0;
const nid = () => `g${++seq}`;
export const leaf = (tabs: string[] = [], active: string | null = null): Leaf => ({ id: nid(), tabs, active });
export const mkPage = (tree: Node, name = '', color = ''): Page => ({
  id: `p${++seq}`,
  name,
  color,
  tree,
  focus: null,
  lastFile: null,
  lastAgent: null,
  zoom: null,
});
export const pageOf = (ws: Workspace) => ws.pages[ws.at];
export function* allLeaves(ws: Workspace): Generator<Leaf> {
  for (const p of ws.pages) yield* leaves(p.tree);
}
export function* everyLeaf(): Generator<Leaf> {
  for (const ws of S().workspaces.values()) yield* allLeaves(ws);
}
export const wsKeys = (ws: Workspace) => [...allLeaves(ws)].flatMap((g) => g.tabs);
export const isLeaf = (n: Node): n is Leaf => !('children' in n);
export function* leaves(n: Node): Generator<Leaf> {
  if (isLeaf(n)) yield n;
  else for (const c of n.children) yield* leaves(c);
}
export const firstLeaf = (lay: { tree: Node }) => leaves(lay.tree).next().value as Leaf;
export const leafById = (lay: { tree: Node }, id: string | null | undefined): Leaf | null => {
  for (const g of leaves(lay.tree)) if (g.id === id) return g;
  return null;
};
export const groupOf = (lay: { tree: Node }, key: string): Leaf | null => {
  for (const g of leaves(lay.tree)) if (g.tabs.includes(key)) return g;
  return null;
};
export function parentOf(tree: Node, node: Node): { parent: Split; index: number } | null {
  if (isLeaf(tree)) return null;
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i];
    if (c === node) return { parent: tree, index: i };
    const r = parentOf(c, node);
    if (r) return r;
  }
  return null;
}
export const renorm = (a: number[]) => {
  const t = a.reduce((x, y) => x + y, 0) || 1;
  return a.map((v) => v / t);
};

/** Drop empty groups, merge splits of the same direction, unwrap single-child splits. */
export function prune(n: Node): Node | null {
  if (isLeaf(n)) return n.tabs.length ? n : null;
  const kids: Node[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    const p = prune(c);
    if (p) {
      kids.push(p);
      sizes.push(n.sizes[i]);
    }
  });
  if (!kids.length) return null;
  n.children = kids;
  n.sizes = renorm(sizes);
  return n;
}
export function normalize(n: Node): Node {
  if (isLeaf(n)) return n;
  n.children = n.children.map(normalize);
  const kids: Node[] = [];
  const sizes: number[] = [];
  n.children.forEach((c, i) => {
    if (!isLeaf(c) && c.dir === n.dir)
      c.children.forEach((cc, j) => {
        kids.push(cc);
        sizes.push(n.sizes[i] * c.sizes[j]);
      });
    else {
      kids.push(c);
      sizes.push(n.sizes[i]);
    }
  });
  n.children = kids;
  n.sizes = renorm(sizes);
  return kids.length === 1 ? kids[0] : n;
}
export function clean(lay: Page) {
  if (!isLeaf(lay.tree) || lay.tree.tabs.length) {
    lay.tree = normalize(prune(lay.tree) || leaf());
  }
  if (!leafById(lay, lay.focus)) lay.focus = firstLeaf(lay).id;
  for (const g of leaves(lay.tree)) if (!g.active || !g.tabs.includes(g.active)) g.active = g.tabs[0] ?? null;
}

export function detach(g: Leaf, key: string) {
  const i = g.tabs.indexOf(key);
  if (i < 0) return;
  g.tabs.splice(i, 1);
  if (g.preview === key) g.preview = null;
  if (g.active === key) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] ?? null;
}
export function attach(g: Leaf, key: string, index?: number | null) {
  if (index == null || index > g.tabs.length) index = g.tabs.length;
  g.tabs.splice(index, 0, key);
  g.active = key;
}
function addAgentTab(g: Leaf, key: string) {
  const { expectReplace } = S();
  const i = expectReplace ? g.tabs.indexOf(expectReplace) : -1;
  if (i >= 0) {
    // started from a new-tab launcher: take its place
    g.tabs[i] = key;
    g.active = key;
    useLayoutStore.setState({ expectReplace: null });
    return;
  }
  g.tabs.push(key);
  if (!g.active) g.active = key;
}
export function splitGroup(lay: Page, target: Leaf, side: Side, key: string | null) {
  const ng = key ? leaf([key], key) : leaf();
  const node: Split = {
    dir: side === 'left' || side === 'right' ? 'row' : 'col',
    sizes: [0.5, 0.5],
    children: side === 'left' || side === 'top' ? [ng, target] : [target, ng],
  };
  const info = parentOf(lay.tree, target);
  if (info) info.parent.children[info.index] = node;
  else lay.tree = node;
  return ng;
}

// ------------------------------------------------------------------ persistence

export function revive(n: Any): Node | null {
  if (!n || typeof n !== 'object') return null;
  if (Array.isArray(n.children)) {
    const pairs = (n.children as Any[])
      .map((c, i) => [revive(c), n.sizes && n.sizes[i] > 0 ? n.sizes[i] : 1])
      .filter((p) => p[0]) as [Node, number][];
    if (!pairs.length) return null;
    return {
      dir: n.dir === 'col' ? 'col' : 'row',
      children: pairs.map((p) => p[0]),
      sizes: renorm(pairs.map((p) => p[1])),
    };
  }
  const tabs: string[] = (Array.isArray(n.tabs) ? n.tabs : []).filter(
    (k: Any) => typeof k === 'string' && /^(?:[afn]:|d:[swc]:)./.test(k),
  );
  return leaf(tabs, tabs.includes(n.active) ? n.active : (tabs[0] ?? null));
}
export const dump = (n: Node): Any =>
  isLeaf(n)
    ? { tabs: n.tabs.slice(0, 40), active: n.active }
    : { dir: n.dir, sizes: n.sizes, children: n.children.map(dump) };

let saveTimer: ReturnType<typeof setTimeout>;
export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out: Record<string, Any> = {};
    for (const [r, ws] of S().workspaces)
      out[r] = { at: ws.at, pages: ws.pages.map((p) => ({ name: p.name, color: p.color, tree: dump(p.tree) })) };
    H.saveUi({ pages: out, layouts: null });
  }, 300);
}

/** Parse the saved ui blob ({ tabs, pages, layouts }) into workspaces. */
export function initFromUi(ui: Any) {
  const legacy: Record<string, { tabs?: string[] }> = { ...(ui.tabs || {}) };
  const workspaces = new Map<string, Workspace>();
  for (const [r, w] of Object.entries<Any>(ui.pages || {})) {
    const pages = (Array.isArray(w?.pages) ? w.pages : [])
      .map((p: Any) => {
        const tree = revive(p?.tree);
        return (
          tree &&
          mkPage(
            normalize(tree),
            typeof p.name === 'string' ? p.name.slice(0, 60) : '',
            PAGE_COLORS.find((c) => c.hex === p.color)?.hex,
          )
        );
      })
      .filter(Boolean) as Page[];
    if (pages.length) workspaces.set(r, { pages, at: Math.min(Math.max(0, w.at | 0), pages.length - 1) });
  }
  // before pages: one layout tree per worktree
  for (const [r, t] of Object.entries<Any>(ui.layouts || {})) {
    const tree = workspaces.has(r) ? null : revive(t);
    if (tree) workspaces.set(r, { pages: [mkPage(normalize(tree))], at: 0 });
  }
  useLayoutStore.setState({ legacy, workspaces });
}

export function wsOf(r: string): Workspace {
  const st = S();
  let ws = st.workspaces.get(r);
  if (!ws) {
    // first run with split panes: carry over the file tabs that were open before
    const files = (st.legacy[r]?.tabs || []).map((p) => `f:${p}`);
    delete st.legacy[r];
    ws = { pages: [mkPage(leaf(files, null))], at: 0 };
    st.workspaces.set(r, ws);
  }
  const lay = pageOf(ws);
  if (!lay.focus || !leafById(lay, lay.focus)) lay.focus = firstLeaf(lay).id;
  return ws;
}
export const ensure = (r: string) => pageOf(wsOf(r));
export const cur = () => {
  const r = S().root;
  return r ? ensure(r) : null;
};

// ------------------------------------------------------------------ sessions <-> agent tabs

function agentTarget(lay: Page): Leaf {
  const { expectGroup } = S();
  if (expectGroup && leafById(lay, expectGroup)) return leafById(lay, expectGroup) as Leaf;
  const withAgent = [...leaves(lay.tree)].find((g) => g.tabs.some((k) => k.startsWith('a:')));
  return withAgent || leafById(lay, lay.focus) || firstLeaf(lay);
}

/** New agents land in the current page; agents that died are dropped from every page. */
export function reconcile(ws: Workspace, ids: string[]) {
  const live = new Set(ids);
  for (const g of allLeaves(ws))
    for (const k of [...g.tabs]) if (k.startsWith('a:') && !live.has(k.slice(2))) detach(g, k);
  const placed = new Set(wsKeys(ws));
  for (const id of ids) if (!placed.has(`a:${id}`)) addAgentTab(agentTarget(pageOf(ws)), `a:${id}`);
  for (const p of ws.pages) clean(p);
}

export function setRoot(r: string | null, ids: string[]) {
  useLayoutStore.setState({ root: r });
  if (r) {
    reconcile(wsOf(r), ids);
    const files = filesOf(r);
    if (files.length) preload(files).then((missing: string[]) => missing.forEach(removeFile));
    persist();
  }
  commit({ force: true, persist: false });
}
export function sync(r: string | null, ids: string[]) {
  if (!r || r !== S().root) return;
  reconcile(wsOf(r), ids);
  commit();
}

// ------------------------------------------------------------------ tab actions

export function noteKind(lay: Page, g: Leaf) {
  if (!g.active) return;
  if (g.active.startsWith('a:')) lay.lastAgent = g.active;
  else lay.lastFile = g.id;
}

export function activate(g: Leaf, key: string) {
  const lay = cur() as Page;
  g.active = key;
  lay.focus = g.id;
  noteKind(lay, g);
  commit();
  fx.afterActivate(g, key);
}

/** Mark a group (or null) focused in the current page; model only, no persist, no fx calls. */
export function setFocus(id: string | null) {
  const lay = cur();
  if (!lay) return;
  if (id === null || leafById(lay, id)) lay.focus = id;
  const g = leafById(lay, id);
  if (g) noteKind(lay, g); // noteKind reads g.active — skip when nothing matches
  useLayoutStore.setState((s) => ({ rev: s.rev + 1 }));
}

export function closeKey(key: string) {
  if (key.startsWith('f:')) closeTab(key.slice(2));
  else if (key.startsWith('d:')) closeDiff(key);
  else if (key.startsWith('n:')) removeKey(key);
  else stopAgent(key.slice(2));
}

export const removeFile = (path: string) => removeKey(`f:${path}`);
export function removeKey(key: string) {
  for (const ws of S().workspaces.values()) {
    for (const lay of ws.pages) {
      const g = groupOf(lay, key);
      if (!g) continue;
      detach(g, key);
      clean(lay);
    }
  }
  commit();
}

export function closeActive() {
  const k = activeKey();
  if (k) closeKey(k);
  else closeEmptyPane();
}

export const isDirtyKey = (k: string) =>
  k.startsWith('f:') ? tabInfo(k.slice(2)).dirty : k.startsWith('d:') ? diffInfo(k).dirty : false;
export const isPreviewable = (k: string) => k.startsWith('f:') || k.startsWith('d:');

export async function openFile(path: string, opts: OpenOpts = {}) {
  return openKey(`f:${path}`, opts);
}
export async function openDiff(mode: string, path: string, opts: OpenOpts = {}) {
  return openKey(`d:${mode}:${path}`, opts);
}

export async function openKey(
  key: string,
  { focus = true, preview = false, pin = false }: OpenOpts = {},
): Promise<string | null> {
  let lay = cur();
  if (!lay) return null;
  let g = groupOf(lay, key);
  if (!g) {
    // already open in another page of this workspace: go there
    const ws = S().workspaces.get(S().root as string) as Workspace;
    const other = ws.pages.find((p) => groupOf(p, key));
    if (other) {
      g = groupOf(other, key);
      if (focus) {
        ws.at = ws.pages.indexOf(other);
        lay = other;
      }
    }
  }
  if (!g) {
    g = (leafById(lay, lay.lastFile) || leafById(lay, lay.focus)) as Leaf;
    const old = g.preview && g.tabs.includes(g.preview) ? g.preview : null;
    if (old && preview && isPreviewable(old) && !isDirtyKey(old)) {
      // a new preview replaces the previous one in place
      g.tabs[g.tabs.indexOf(old)] = key;
      g.preview = key;
      if (old.startsWith('f:')) dropPath(old.slice(2));
      else dropDiff(old);
    } else {
      const at = g.active && g.tabs.includes(g.active) ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
      g.tabs.splice(at, 0, key);
      g.preview = preview ? key : null;
    }
  } else if (pin && g.preview === key) g.preview = null;
  g.active = key;
  if (focus) lay.focus = g.id;
  if (leafById(lay, g.id)) lay.lastFile = g.id;
  commit();
  return fx.pendingMount(g.id) ?? g.id;
}

export function revealAgent(id: string) {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  const key = `a:${id}`;
  const lay = ws?.pages.find((p) => groupOf(p, key));
  if (!ws || !lay) return;
  ws.at = ws.pages.indexOf(lay);
  const g = groupOf(lay, key) as Leaf;
  g.active = key;
  lay.focus = g.id;
  noteKind(lay, g);
  commit();
}

export function currentAgent() {
  const lay = cur();
  if (!lay) return null;
  const g = leafById(lay, lay.focus);
  if (g?.active?.startsWith('a:')) return g.active.slice(2);
  if (lay.lastAgent && groupOf(lay, lay.lastAgent)) return lay.lastAgent.slice(2);
  const any =
    [...leaves(lay.tree)].flatMap((x) => x.tabs).find((k) => k.startsWith('a:')) ||
    wsKeys(S().workspaces.get(S().root as string) as Workspace).find((k) => k.startsWith('a:'));
  return any ? any.slice(2) : null;
}

export function activeFile() {
  const lay = cur();
  const g = lay && leafById(lay, lay.focus);
  return g?.active?.startsWith('f:') ? g.active.slice(2) : null;
}
export const activeKey = () => {
  const lay = cur(),
    g = lay && leafById(lay, lay.focus);
  return g ? g.active : null;
};

/** Focus the editor most recently used; false if no group shows a file. */
export function focusEditor() {
  const lay = cur();
  if (!lay) return false;
  const showing = (g: Leaf | null) => !!g?.active?.startsWith('f:');
  const g = [leafById(lay, lay.focus), leafById(lay, lay.lastFile), ...leaves(lay.tree)].find(showing);
  if (!g?.active) return false;
  lay.focus = g.id;
  commit({ persist: false });
  fx.afterActivate(g, g.active);
  return true;
}

/** Zoom the focused pane to fill the workspace view (or restore). Other panes stay mounted underneath. */
export function toggleZoom() {
  const lay = cur();
  if (!lay) return;
  if (lay.zoom) lay.zoom = null;
  else if (!isLeaf(lay.tree)) lay.zoom = lay.focus;
  else return;
  commit({ persist: false });
  const g = leafById(lay, lay.focus);
  if (g?.active) fx.afterActivate(g, g.active);
}

export const hasKey = (key: string) => [...everyLeaf()].some((g) => g.tabs.includes(key));
export const hasFile = (path: string) => hasKey(`f:${path}`) || hasKey(`d:w:${path}`);
export const filesOf = (r: string) =>
  S().workspaces.has(r)
    ? wsKeys(S().workspaces.get(r) as Workspace)
        .filter((k) => k.startsWith('f:'))
        .map((k) => k.slice(2))
    : [];

export function forgetRoot(r: string) {
  const st = S();
  st.workspaces.delete(r);
  delete st.legacy[r];
  useLayoutStore.setState((s) => ({ rev: s.rev + 1 }));
  if (st.root === r) {
    useLayoutStore.setState({ root: null });
    fx.renderRoot(true);
  } else {
    fx.gc();
  }
  persist();
}

export function expectAgent(id: string | null) {
  const lay = cur(),
    g = id && lay ? leafById(lay, id) : undefined;
  useLayoutStore.setState({ expectGroup: id, expectReplace: g?.active?.startsWith('n:') ? g.active : null });
}

// ------------------------------------------------------------------ pages

export const PAGE_COLORS = [
  { name: 'Red', hex: '#f38ba8' },
  { name: 'Orange', hex: '#fab387' },
  { name: 'Yellow', hex: '#f9e2af' },
  { name: 'Green', hex: '#a6e3a1' },
  { name: 'Teal', hex: '#94e2d5' },
  { name: 'Blue', hex: '#89b4fa' },
  { name: 'Purple', hex: '#cba6f7' },
  { name: 'Pink', hex: '#f5c2e7' },
];
export const pageLabel = (p: Page, i: number) => p.name || `Page ${i + 1}`;

export function setPage(i: number) {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  if (!ws || i < 0 || i >= ws.pages.length || i === ws.at) return;
  ws.at = i;
  commit();
  const lay = pageOf(ws);
  fx.focusGroup(leafById(lay, lay.focus) || firstLeaf(lay));
}
export const cyclePage = (dir: number) => {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  if (ws && ws.pages.length > 1) setPage((ws.at + dir + ws.pages.length) % ws.pages.length);
};

/** Add an empty page right after the current one and switch to it. */
export function newPage() {
  const r = S().root;
  const ws = r && wsOf(r);
  if (!ws) return;
  const p = mkPage(leaf());
  p.focus = firstLeaf(p).id;
  ws.pages.splice(ws.at + 1, 0, p);
  ws.at++;
  commit();
  fx.focusGroup(firstLeaf(p));
}

/** Remove a page; its tabs move into the focused pane of the previous page (the next one for the first page). */
export function closePage(i: number) {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  if (!ws || ws.pages.length < 2 || !ws.pages[i]) return;
  const p = ws.pages[i],
    into = ws.pages[i ? i - 1 : 1];
  const dest = leafById(into, into.focus) || firstLeaf(into);
  for (const g of leaves(p.tree)) {
    for (const k of g.tabs) if (k.startsWith('f:')) saveView(g.id, k.slice(2));
    dest.tabs.push(...g.tabs);
    if (!dest.active) dest.active = g.active;
  }
  ws.pages.splice(i, 1);
  ws.at = ws.pages.indexOf(into);
  clean(into);
  into.focus = dest.id;
  commit();
  fx.focusGroup(dest);
}

export function setPageColor(i: number, color: string) {
  const { root, workspaces } = S();
  const page = root ? workspaces.get(root)?.pages[i] : undefined;
  if (!page) return;
  page.color = color;
  fx.renderPageBar();
  persist();
}

export function setPageName(i: number, name: string) {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  if (!ws?.pages[i]) return;
  ws.pages[i].name = name;
  fx.renderPageBar();
  persist();
}

/** Move a page chip to a new slot; `at` follows the current page. */
export function movePage(from: number, to: number) {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  if (!ws || from < 0 || from >= ws.pages.length) return;
  const cur = ws.pages[ws.at];
  const [p] = ws.pages.splice(from, 1);
  ws.pages.splice(to > from ? to - 1 : to, 0, p);
  ws.at = ws.pages.indexOf(cur);
  fx.renderPageBar();
  persist();
}

/** Page chips of the active workspace, for menus. */
export function pages() {
  const { root, workspaces } = S();
  const ws = root ? workspaces.get(root) : undefined;
  return ws ? ws.pages.map((p, i) => ({ i, label: pageLabel(p, i) })) : [];
}

export function focusedGroup() {
  const lay = cur();
  return lay ? lay.focus : null;
}

// ------------------------------------------------------------------ move / split tabs

export function moveTab(key: string, drop: DropTarget) {
  const lay = cur() as Page;
  const src = groupOf(lay, key);
  if (drop.kind === 'page') return moveToPage(key, src, drop.page);
  const tgt = drop.g;
  if (drop.kind === 'edge' && src === tgt && tgt.tabs.length <= 1) return;
  if (src && key.startsWith('f:')) saveView(src.id, key.slice(2));
  if (src) detach(src, key);
  let dest = tgt;
  if (drop.kind === 'edge') dest = splitGroup(lay, tgt, drop.side, key);
  else attach(tgt, key, drop.kind === 'tab' ? drop.index : null);
  clean(lay);
  lay.focus = dest.id;
  noteKind(lay, dest);
  if (key.startsWith('f:')) lay.lastFile = dest.id;
  commit();
  fx.afterActivate(dest, key);
}

/** Move a tab into the focused pane of another page and switch there. */
export function moveToPage(key: string, src: Leaf | null, i: number) {
  const ws = S().workspaces.get(S().root as string) as Workspace;
  const lay = pageOf(ws),
    tp = ws.pages[i];
  if (!tp || tp === lay) return;
  if (src && key.startsWith('f:')) saveView(src.id, key.slice(2));
  if (src) detach(src, key);
  const dest = leafById(tp, tp.focus) || firstLeaf(tp);
  attach(dest, key);
  clean(lay);
  ws.at = i;
  tp.focus = dest.id;
  noteKind(tp, dest);
  if (key.startsWith('f:')) tp.lastFile = dest.id;
  commit();
  fx.afterActivate(dest, key);
}

/** Merge all of src's tabs into tgt (whole-pane drag). */
export function mergeGroup(src: Leaf, tgt: Leaf) {
  const lay = cur() as Page;
  const active = src.active;
  for (const k of src.tabs) if (k.startsWith('f:')) saveView(src.id, k.slice(2));
  tgt.tabs.push(...src.tabs);
  src.tabs = [];
  tgt.active = active;
  clean(lay);
  lay.focus = tgt.id;
  noteKind(lay, tgt);
  if (tgt.tabs.some((k) => k.startsWith('f:'))) lay.lastFile = tgt.id;
  commit();
  if (active) fx.afterActivate(tgt, active);
}

/** Split the focused pane with an empty one on `side`; the next opened file lands there. */
export function splitFocused(side: Side) {
  const lay = cur();
  const src = lay && leafById(lay, lay.focus);
  if (!src) return;
  const ng = splitGroup(lay, src, side, null);
  lay.zoom = null;
  lay.focus = lay.lastFile = ng.id;
  commit();
  fx.focusGroup(ng);
  return ng;
}

/** The pane immediately right of group `gid` (overlapping it vertically), split off an empty one if there is none. */
export function paneRightOf(gid: string) {
  const lay = cur();
  const src = lay && leafById(lay, gid);
  if (!lay || !src) return;
  const r = fx.groupRect(src.id);
  const right = r
    ? [...leaves(lay.tree)]
        .filter((g) => g !== src)
        .map((g) => ({ g, b: fx.groupRect(g.id) }))
        .filter((x): x is { g: Leaf; b: DOMRect } => !!x.b)
        .filter(({ b }) => b.left >= r.right - 1 && b.top < r.bottom && b.bottom > r.top)
        .sort((a, b) => a.b.left - b.b.left)[0]?.g
    : undefined;
  if (right) return right;
  const ng = splitGroup(lay, src, 'right', null);
  commit();
  return ng;
}

/** Close the focused pane when it has no tabs (the last pane of a page stays). */
export function closeEmptyPane() {
  const lay = cur();
  const g = lay && leafById(lay, lay.focus);
  const info = g && !g.tabs.length && parentOf(lay.tree, g);
  if (!info) return;
  const { parent, index } = info;
  parent.children.splice(index, 1);
  parent.sizes.splice(index, 1);
  parent.sizes = renorm(parent.sizes);
  const next = parent.children[Math.min(index, parent.children.length - 1)];
  lay.tree = normalize(lay.tree);
  lay.zoom = null;
  lay.focus = lay.lastFile = firstLeaf({ tree: next }).id;
  commit();
  fx.focusGroup(leafById(lay, lay.focus) as Leaf);
}

/** Open a new-tab launcher after the focused pane's active tab (or focus the one already there). */
export function newTab() {
  const lay = cur();
  const g = lay && leafById(lay, lay.focus);
  if (!g) return null;
  if (g.active?.startsWith('n:')) {
    fx.afterActivate(g, g.active);
    return g;
  }
  const key = `n:${Date.now().toString(36)}${(++seq).toString(36)}`;
  const at = g.active && g.tabs.includes(g.active) ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
  g.tabs.splice(at, 0, key);
  g.active = key;
  noteKind(lay, g);
  commit();
  fx.afterActivate(g, key);
  return g;
}

/** Activate the previous/next tab of the focused group, wrapping around. */
export function cycleTab(dir: number) {
  const lay = cur();
  const g = lay && leafById(lay, lay.focus);
  if (!g || g.tabs.length < 2) return;
  const i = g.tabs.indexOf(g.active as string);
  activate(g, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

/** Move the focused group's active tab to the neighbouring group (dir -1/+1, or 'up'/'down' by position), splitting off a new one at the end. */
export function moveActive(dir: number | 'up' | 'down') {
  const lay = cur();
  const src = lay ? leafById(lay, lay.focus) : undefined;
  const key = src?.active;
  if (!lay || !src || !key) return;
  if (dir === 'up' || dir === 'down') {
    const r = fx.groupRect(src.id);
    if (!r) return;
    const near = [...leaves(lay.tree)]
      .filter((g) => g !== src)
      .map((g) => ({ g, b: fx.groupRect(g.id) }))
      .filter((x): x is { g: Leaf; b: DOMRect } => !!x.b)
      .filter(
        ({ b }) =>
          (dir === 'up' ? b.bottom <= r.top + 1 : b.top >= r.bottom - 1) && b.left < r.right && b.right > r.left,
      )
      .sort((a, b) => (dir === 'up' ? b.b.bottom - a.b.bottom : a.b.top - b.b.top));
    if (near.length) moveTab(key, { kind: 'center', g: near[0].g });
    else if (src.tabs.length > 1)
      moveTab(key, { kind: 'edge', g: src, side: dir === 'up' ? ('top' as const) : ('bottom' as const) });
    return;
  }
  const all = [...leaves(lay.tree)];
  const tgt = all[all.indexOf(src) + dir];
  if (tgt) moveTab(key, { kind: 'center', g: tgt });
  else if (src.tabs.length > 1)
    moveTab(key, { kind: 'edge', g: src, side: dir < 0 ? ('left' as const) : ('right' as const) });
}
