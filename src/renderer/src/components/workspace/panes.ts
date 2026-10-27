// Pane registry + DOM-side half of the workspace, ported from legacy/layout.ts for the
// React migration. Owns the per-group HTMLElement hosts (`.ghost`, `.gdiff`) that Monaco
// editors / diffs render into: they are created once per group id and survive React
// remounts — EditorPane / DiffPane adopt them and show / hide them from `useGroupView`,
// which syncShown / mount drive (image and binary placeholders are plain React there). The launcher is React-rendered (Launcher.tsx); its model
// state lives on the GroupReg and re-render happens through bumpTick().
import { createElement, Fragment, type ReactNode } from 'react';
import { create } from 'zustand';
import type { Session } from '../../../../shared/types';
import { appSettings, focusTerm, markSidebar, newAgent, termEl } from '../../lib/actions';
import { track } from '../../lib/dnd';
import type { FileMatch } from '../../lib/editor/fileIndex';
import { fileIndexLoaded, fileMatches, loadFileIndex, openFileResult } from '../../lib/editor/fileIndex';
import { H } from '../../lib/legacy';
import { fitAll } from '../../lib/terminals';
import { openFile } from '../editor/api';
import { FileRow } from '../editor/FileRow';
import { disposeGroup, focusGroup as focusEditorGroup, groupFocused, show, showDiff } from '../editor/host';
import type { Leaf, Side } from './layoutStore';
import {
  closePage,
  configureLayoutStore,
  cur,
  ensure,
  everyLeaf,
  groupOf,
  isLeaf,
  leafById,
  leaves,
  mergeGroup,
  moveTab,
  newTab,
  removeFile,
  removeKey,
  setFocus,
  useLayoutStore,
} from './layoutStore';

export interface LaunchItem {
  kind?: boolean;
  node: ReactNode;
  run(): unknown;
}
interface ChatHist {
  items: { title?: string; updatedAt: string; sessionId: string }[] | null;
  error: string | null;
}
/** Per-group renderer state. el/body/lq are wired by GroupPane / Launcher refs (null until
 * then); the host elements are created once by regFor and adopted into the React DOM. */
export interface GroupReg {
  el: HTMLElement | null;
  body: HTMLElement | null;
  host: HTMLElement;
  diffHost: HTMLElement;
  lq: HTMLInputElement | null;
  litems: LaunchItem[];
  lsel: number;
  lnaming: boolean;
  lhist: ChatHist | null;
  lerr: string | null;
  lqText: string;
  tok: number;
  mounted: string | null;
  pending: Promise<string | null> | null;
  shown: string | null;
  /** whether the launcher was visible at the last syncShown (reset trigger) */
  launchShown: boolean;
}
type Drop =
  | { kind: 'page'; page: number; rect: number[] }
  | { kind: 'tab'; g: Leaf; index: number; bar: { x: number; top: number; h: number } }
  | { kind: 'edge'; g: Leaf; side: Side; rect?: number[] }
  | { kind: 'center'; g: Leaf; rect?: number[] };

const _esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
const L = () => useLayoutStore.getState();
const EDGE = 0.25; // outer fraction of a group that splits it when dropped on

export const groups = new Map<string, GroupReg>();

const hostDiv = (cls: string) => {
  const el = document.createElement('div');
  el.className = cls;
  el.hidden = true;
  return el;
};

/** What a group's body currently shows from the Monaco side (EditorPane / DiffPane render it). */
export interface GroupView {
  editor: boolean;
  diff: boolean;
  image: string | null;
  binary: boolean;
}
const NO_VIEW: GroupView = { editor: false, diff: false, image: null, binary: false };
export const useGroupView = create<{ views: Record<string, GroupView | undefined> }>(() => ({ views: {} }));
function setView(gid: string, patch: Partial<GroupView>) {
  const cur = useGroupView.getState().views[gid] ?? NO_VIEW;
  const next = { ...cur, ...patch };
  if ((Object.keys(next) as (keyof GroupView)[]).every((k) => next[k] === cur[k])) return;
  useGroupView.setState((s) => ({ views: { ...s.views, [gid]: next } }));
}

/** The persistent per-group renderer record; created once per group id. */
export function regFor(gid: string): GroupReg {
  const known = groups.get(gid);
  if (known) return known;
  const reg: GroupReg = {
    el: null,
    body: null,
    host: hostDiv('ghost'),
    diffHost: hostDiv('gdiff'),
    lq: null,
    litems: [],
    lsel: 0,
    lnaming: false,
    lhist: null,
    lerr: null,
    lqText: '',
    tok: 0,
    mounted: null,
    pending: null,
    shown: null,
    launchShown: false,
  };
  groups.set(gid, reg);
  return reg;
}

// ------------------------------------------------------------------ re-render tick

/** Workspace chrome re-render signal (page bar, tab bars, launcher). */
export const useUiTick = create<{ tick: number; renamePageAt: number | null }>(() => ({
  tick: 0,
  renamePageAt: null,
}));
export const bumpTick = () => useUiTick.setState((s) => ({ tick: s.tick + 1 }));
/** Cheap refresh of tab labels (dirty / error marks, agent spinners) + page bar. */
export const renderTabs = bumpTick;

/** Tab label: user's name, else the agent's name / the terminal's running command. */
export function agentLabel(info: Session | null) {
  if (!info) return 'agent';
  if (info.title) return info.title;
  if (info.kind === 'terminal') return info.proc || `terminal ${info.index}`;
  return info.name || `agent ${info.index}`;
}

// ------------------------------------------------------------------ mounting

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

async function mount(g: Leaf, reg: GroupReg, path: string) {
  const tok = ++reg.tok;
  const m = await show(g.id, reg.host, path);
  if (tok !== reg.tok) return g.id;
  if (!m || m.error) {
    reg.mounted = null;
    removeFile(path);
    return null;
  }
  const img = m.binary && IMAGE_EXT.test(path);
  setView(g.id, {
    editor: !!m.model,
    image: img ? `file://${encodeURI(path).replace(/[#?]/g, encodeURIComponent)}` : null,
    binary: !!m.binary && !img,
  });
  return g.id;
}

async function mountDiff(g: Leaf, reg: GroupReg, key: string) {
  const tok = ++reg.tok;
  const m = await showDiff(g.id, reg.diffHost, key);
  if (tok !== reg.tok) return g.id;
  if (!m || m.error) {
    reg.mounted = null;
    removeKey(key);
    return null;
  }
  setView(g.id, { diff: !m.binary, image: null, binary: !!m.binary });
  return g.id;
}

/** The launcher shows for an `n:` tab, or for an empty pane (when a worktree is open). */
export const launcherVisible = (g: Leaf) => {
  const act = g.active;
  return act ? act.startsWith('n:') : !!L().root;
};

const setLq = (reg: GroupReg, v: string) => {
  reg.lqText = v;
  if (reg.lq) reg.lq.value = v;
};

/** The body-sync half of legacy renderGroup: adopt terminals into the group body, mount
 * files/diffs through the persistent hosts, reset the launcher when it appears. */
export function syncShown(g: Leaf) {
  const reg = regFor(g.id);
  const act = g.active;
  if (reg.body)
    for (const k of g.tabs) {
      if (!k.startsWith('a:')) continue;
      const el = termEl(k.slice(2));
      if (el.parentNode !== reg.body) reg.body.appendChild(el);
      el.hidden = k !== act;
    }
  if (act?.startsWith('f:')) {
    setView(g.id, { editor: true, diff: false });
    if (reg.mounted !== act) {
      reg.mounted = act;
      reg.pending = mount(g, reg, act.slice(2));
    }
  } else if (act?.startsWith('d:')) {
    setView(g.id, { editor: false, diff: true, image: null });
    if (reg.mounted !== act) {
      reg.mounted = act;
      reg.pending = mountDiff(g, reg, act);
    }
  } else {
    reg.mounted = null;
    setView(g.id, NO_VIEW);
  }
  const show = launcherVisible(g);
  if (show && !reg.launchShown) {
    reg.lsel = 0;
    reg.lnaming = false;
    reg.lhist = null;
    setLq(reg, '');
    renderLaunch(g);
  }
  reg.launchShown = show;
  reg.shown = act;
}

// ------------------------------------------------------------------ focus

/** Group ids whose launcher input wants focus once Launcher.tsx mounts/updates. */
export const wantLauncherFocus = new Set<string>();

function afterActivate(g: Leaf, key: string) {
  if (key.startsWith('a:')) focusTerm(key.slice(2));
  else if (key.startsWith('n:')) {
    wantLauncherFocus.add(g.id);
    regFor(g.id).lq?.focus();
  } else focusEditorGroup(g.id);
}

/** Port of legacy setFocus: model focus via the store, then the leftover DOM side effects. */
export function markFocused(id: string | null) {
  const lay = cur();
  if (!lay || !leafById(lay, id)) return;
  setFocus(id);
  groupFocused(id as string);
  markSidebar();
}

function focusGroup(g: Leaf) {
  markFocused(g.id);
  if (g.active) afterActivate(g, g.active);
  else {
    wantLauncherFocus.add(g.id);
    regFor(g.id).lq?.focus();
  }
}

/** Overlay a number on each visible pane; the digit pressed focuses that pane. Triggering again cycles to the next pane. */
let pickOff: (() => void) | null = null;
export function pickPane() {
  const lay = cur();
  if (!lay) return;
  const rectOf = (g: Leaf) => groups.get(g.id)?.el?.getBoundingClientRect() ?? null;
  // visual order: rows top to bottom, left to right within a row
  const gs = [...leaves(lay.tree)]
    .filter((g) => {
      const r = rectOf(g);
      return r?.width && r.height;
    })
    .sort((a, b) => {
      const ra = rectOf(a) as DOMRect,
        rb = rectOf(b) as DOMRect;
      return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
    });
  if (gs.length < 2) return;
  if (pickOff) {
    const next = gs[(gs.findIndex((g) => g.id === lay.focus) + 1) % gs.length];
    pickOff();
    return focusGroup(next);
  }
  const badges = gs.slice(0, 9).map((g, i) => {
    const r = rectOf(g) as DOMRect;
    const b = document.createElement('div');
    b.className = `pane-pick${g.id === lay.focus ? ' cur' : ''}`;
    b.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
    b.innerHTML = `<span>${i + 1}</span>`;
    document.body.appendChild(b);
    return b;
  });
  const off = () => {
    pickOff = null;
    for (const b of badges) b.remove();
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('mousedown', off, true);
    window.removeEventListener('blur', off);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.metaKey && e.code === 'KeyJ') return; // re-trigger handled by the menu accelerator
    e.preventDefault();
    e.stopPropagation();
    off();
    const n = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (n && !e.metaKey && !e.ctrlKey && !e.altKey && gs[Number(n[1]) - 1]) focusGroup(gs[Number(n[1]) - 1]);
  };
  pickOff = off;
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('mousedown', off, true);
  window.addEventListener('blur', off);
}

// ------------------------------------------------------------------ drag & drop of tabs

let dragKey: string | null = null;
/** The tab key currently being dragged (the tab bar renders its `dragging` class). */
export const getDragKey = () => dragKey;

/** Where would a tab dropped at the pointer land? */
function dropAt(ev: MouseEvent, key: string, src: Leaf | null): Drop | null {
  const lay = cur();
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const chip = el?.closest<HTMLElement>('.pchip');
  if (chip && lay && Number(chip.dataset.i) !== L().workspaces.get(L().root as string)?.at) {
    const r = chip.getBoundingClientRect();
    return { kind: 'page', page: Number(chip.dataset.i), rect: [r.left - 4, r.top - 4, r.width + 8, r.height + 8] };
  }
  const ge = el?.closest<HTMLElement>('.group');
  const g = ge && lay && leafById(lay, ge.dataset.id);
  if (!ge || !g) return null;
  const bar = (ge.querySelector('.gbar') as HTMLElement).getBoundingClientRect();
  if (ev.clientY < bar.bottom) {
    const tabs = [...ge.querySelectorAll<HTMLElement>('.gtab')].filter((t) => t.dataset.key !== key);
    const index = tabs.filter((t) => {
      const r = t.getBoundingClientRect();
      return ev.clientX > r.left + r.width / 2;
    }).length;
    const ref = tabs[Math.min(index, tabs.length - 1)];
    const rr = ref ? ref.getBoundingClientRect() : null;
    const x = !rr ? bar.left + 6 : index < tabs.length ? rr.left - 1 : rr.right + 1;
    return { g, kind: 'tab', index, bar: { x, top: bar.top + 4, h: bar.height - 8 } };
  }
  const b = (ge.querySelector('.gbody') as HTMLElement).getBoundingClientRect();
  const rx = (ev.clientX - b.left) / b.width,
    ry = (ev.clientY - b.top) / b.height;
  const d: Record<Side, number> = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
  const side = (Object.keys(d) as Side[]).reduce((a, k) => (d[k] < d[a] ? k : a), 'left' as Side);
  const lone = src === g && g.tabs.length <= 1;
  if (d[side] < EDGE && !lone) {
    const rect = {
      left: [b.left, b.top, b.width / 2, b.height],
      right: [b.left + b.width / 2, b.top, b.width / 2, b.height],
      top: [b.left, b.top, b.width, b.height / 2],
      bottom: [b.left, b.top + b.height / 2, b.width, b.height / 2],
    }[side];
    return { g, kind: 'edge', side, rect };
  }
  if (src === g) return null;
  return { g, kind: 'center', rect: [b.left, b.top, b.width, b.height] };
}

export function beginDrag(e0: MouseEvent, key: string, label: string) {
  const lay = cur();
  const src = lay && groupOf(lay, key);
  let hint: HTMLElement | undefined;
  let bar: HTMLElement | undefined;
  let ghost: HTMLElement | undefined;
  let drop: Drop | null = null;
  const mk = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    document.body.appendChild(d);
    return d;
  };
  track(e0, {
    onStart() {
      hint = mk('drop-hint');
      bar = mk('drop-bar');
      ghost = mk('drag-ghost');
      hint.hidden = true;
      bar.hidden = true;
      ghost.textContent = label;
      dragKey = key;
      bumpTick();
    },
    onMove(ev) {
      if (!hint || !bar || !ghost) return;
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      drop = dropAt(ev, key, src);
      hint.hidden = !drop || drop.kind === 'tab';
      bar.hidden = drop?.kind !== 'tab';
      if (!drop) return;
      if (drop.kind === 'tab') bar.style.cssText = `left:${drop.bar.x}px;top:${drop.bar.top}px;height:${drop.bar.h}px`;
      else {
        const [l, t, w, h] = drop.rect || [];
        hint.style.cssText = `left:${l + 4}px;top:${t + 4}px;width:${w - 8}px;height:${h - 8}px`;
      }
    },
    onEnd(_ev, moved, cancelled) {
      for (const x of [hint, bar, ghost]) if (x) x.remove();
      if (!moved) return;
      dragKey = null;
      if (!cancelled && drop) moveTab(key, drop);
      else bumpTick();
    },
  });
}

/** Drag a whole pane (grab the empty part of its tab bar) onto another pane to merge all its tabs into it. */
export function beginGroupDrag(e0: MouseEvent, g: Leaf) {
  let hint: HTMLElement | undefined;
  let ghost: HTMLElement | undefined;
  let target: Leaf | null = null;
  const mk = (cls: string) => {
    const d = document.createElement('div');
    d.className = cls;
    document.body.appendChild(d);
    return d;
  };
  track(e0, {
    onStart() {
      hint = mk('drop-hint');
      ghost = mk('drag-ghost');
      hint.hidden = true;
      ghost.textContent = `${g.tabs.length} tab${g.tabs.length === 1 ? '' : 's'}`;
    },
    onMove(ev) {
      if (!hint || !ghost) return;
      ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
      const lay = cur();
      const ge = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.group');
      const t = ge && lay && leafById(lay, ge.dataset.id);
      target = t && t !== g ? t : null;
      hint.hidden = !target;
      if (!target || !ge) return;
      const r = ge.getBoundingClientRect();
      hint.style.cssText = `left:${r.left + 4}px;top:${r.top + 4}px;width:${r.width - 8}px;height:${r.height - 8}px`;
    },
    onEnd(_ev, moved, cancelled) {
      for (const x of [hint, ghost]) if (x) x.remove();
      if (moved && !cancelled && target) mergeGroup(g, target);
    },
  });
}

/** Start dragging something that is not a tab yet (e.g. a row of the file tree). */
export function dragFile(e: MouseEvent, path: string, label: string) {
  beginDrag(e, `f:${path}`, label);
}

// ------------------------------------------------------------------ launcher

const LAUNCH_KINDS: ChatKind[] = [
  { k: 'terminal', label: 'Terminal', alias: ['terminal', 'term', 'shell'] },
  { k: 'agent', label: 'Claude Code', alias: ['claude', 'claude code', 'agent', 'code'] },
  { k: 'chat-history', label: 'Resume chat…', alias: ['resume', 'history', 'chat history', 'resume chat'] },
  { k: 'md', label: 'Markdown file', alias: ['markdown', 'md', 'note', 'new file'] },
];

/** Chat rows: the settings.chatAgent one ("Claude Chat"), then the built-ins (Claude, Matilda), then one per other agent in settings.acpAgents. */
interface ChatKind {
  k: string;
  agent?: string;
  label: string;
  alias: string[];
}

function chatKinds(): ChatKind[] {
  const st = appSettings() as {
    acpAgents?: Record<string, { label?: string; command?: string }>;
    chatAgent: string;
  };
  const mine = st.acpAgents && typeof st.acpAgents === 'object' ? st.acpAgents : {};
  const builtin = (n: string) => n === 'claude' || n === 'matilda';
  const label = (n: string) => (n === 'claude' ? 'Claude' : mine[n]?.label || (n === 'matilda' ? 'Matilda' : n));
  const main = mine[st.chatAgent] || builtin(st.chatAgent) ? st.chatAgent : 'claude';
  const names = [
    main,
    ...['claude', 'matilda', ...Object.keys(mine)].filter(
      (n, i, a) => n !== main && a.indexOf(n) === i && (builtin(n) || mine[n]?.command),
    ),
  ];
  return names.map((n) => ({
    k: 'chat',
    agent: n,
    label: `${label(n)} Chat`,
    alias: ['chat', `${label(n)} chat`.toLowerCase(), n.toLowerCase()],
  }));
}

/** The launcher input's placeholder for the current mode. */
export function placeholderFor(reg: GroupReg) {
  return reg.lnaming
    ? 'File name, e.g. notes.md'
    : reg.lhist
      ? 'Find a chat…'
      : 'Terminal, Claude, Markdown, or a file name…';
}

/** Muted hint row for the modes/empty states that produce no selectable items (JSX renders it plain). */
export function launchHint(reg: GroupReg): string | null {
  if (reg.lnaming) return 'Enter to create it in the worktree root · Esc to go back';
  if (reg.lhist)
    return reg.litems.length ? null : (reg.lhist.error ?? (reg.lhist.items ? 'No saved chats' : 'Loading…'));
  return reg.litems.length ? null : 'No matches';
}

/** Rebuild the launcher's rows: matching kinds, then files by fuzzy name, then "create <name>". */
export function renderLaunch(g: Leaf) {
  const reg = groups.get(g.id);
  if (!reg) return;
  reg.lerr = null;
  if (reg.lq) reg.lq.placeholder = placeholderFor(reg);
  const raw = reg.lqText,
    q = raw.trim().toLowerCase();
  if (reg.lnaming) {
    reg.litems = [];
    bumpTick();
    return;
  }
  if (reg.lhist) {
    const h = reg.lhist;
    const rows = h.items ? h.items.filter((x) => !q || (x.title || 'Untitled chat').toLowerCase().includes(q)) : [];
    reg.litems = rows.map((x) => ({
      node: createElement(
        Fragment,
        null,
        createElement('span', null, x.title || 'Untitled chat'),
        createElement('span', { className: 'lhint' }, ago(x.updatedAt)),
      ),
      run: () => newAgent(g.id, 'chat', { sessionId: x.sessionId, title: x.title }),
    }));
    reg.lsel = Math.min(reg.lsel, Math.max(0, reg.litems.length - 1));
    bumpTick();
    return;
  }
  const items: LaunchItem[] = [...LAUNCH_KINDS.slice(0, 2), ...chatKinds(), ...LAUNCH_KINDS.slice(2)]
    .filter((x) => !q || x.alias.some((a) => a.startsWith(q)) || x.label.toLowerCase().includes(q))
    .map(
      (x): LaunchItem => ({
        kind: true,
        node: createElement('span', null, x.label),
        run: () =>
          x.k === 'md'
            ? askMarkdownName(g)
            : x.k === 'chat-history'
              ? askChatHistory(g)
              : newAgent(g.id, x.k, x.agent ? { agent: x.agent } : undefined),
      }),
    );
  if (!fileIndexLoaded())
    loadFileIndex().then(() => {
      if (launcherVisible(g) && !reg.lnaming) renderLaunch(g);
    });
  else {
    const files = fileMatches(raw).slice(0, !q ? 5 : items.length ? 4 : 8);
    for (const r of files as { f: string }[])
      items.push({ node: createElement(FileRow, { r }), run: () => openFromLauncher(g, r) });
    const name = raw.trim();
    if (name && !items.some((it) => it.kind) && !/[/\\:]/.test(name) && !files.some((r: { f: string }) => r.f === name))
      items.push({
        node: createElement('span', null, 'Create ', createElement('b', null, name)),
        run: () => createMarkdown(g, name),
      });
  }
  reg.litems = items;
  reg.lsel = Math.min(reg.lsel, Math.max(0, items.length - 1));
  bumpTick();
}
export function runLaunch(g: Leaf, i: number) {
  const reg = groups.get(g.id);
  const it = reg?.litems[i];
  if (reg && it)
    Promise.resolve()
      .then(it.run)
      .catch((e: Error) => {
        reg.lerr = e.message;
        bumpTick();
      });
}

const ago = (t: string) => {
  const m = Math.round((Date.now() - Date.parse(t)) / 60000);
  return !Number.isFinite(m)
    ? ''
    : m < 1
      ? 'now'
      : m < 60
        ? `${m}m ago`
        : m < 1440
          ? `${Math.round(m / 60)}h ago`
          : `${Math.round(m / 1440)}d ago`;
};

/** Swap the launcher's rows for the agent's saved chats of this worktree (session/list). */
async function askChatHistory(g: Leaf) {
  const reg = groups.get(g.id);
  if (!reg) return;
  const h: NonNullable<GroupReg['lhist']> = { items: null, error: null };
  reg.lhist = h;
  reg.lsel = 0;
  setLq(reg, '');
  renderLaunch(g);
  reg.lq?.focus();
  try {
    h.items = (await H.chatSessions(L().root as string)) as typeof h.items;
  } catch (e) {
    h.error = (e as Error).message;
  }
  if (reg.lhist === h) renderLaunch(g);
}

/** Swap the launcher's rows for a file-name prompt. */
function askMarkdownName(g: Leaf) {
  const reg = groups.get(g.id);
  if (!reg) return;
  reg.lnaming = true;
  setLq(reg, '');
  renderLaunch(g);
  reg.lq?.focus();
}
/** ⌘N flow: open a new-tab launcher and arm the markdown name prompt. */
export function newMarkdown() {
  const g = newTab();
  if (g) askMarkdownName(g);
}

/** Open an existing file in place of the launcher. */
async function openFromLauncher(g: Leaf, r: FileMatch) {
  const launcher = g.active,
    lay = cur();
  if (lay && leafById(lay, g.id)) lay.lastFile = g.id;
  await openFileResult(r);
  if (launcher?.startsWith('n:')) removeKey(launcher);
}

/** Create `name` (.md unless it has an extension) in the worktree root, open it in place of the launcher. An existing file is just opened. */
async function createMarkdown(g: Leaf, raw: string) {
  let name = raw.trim();
  const reg = groups.get(g.id);
  const r = L().root;
  if (!name || !r || !reg) return;
  const fail = (msg: string) => {
    reg.lerr = msg;
    bumpTick();
  };
  if (/[/\\]/.test(name)) return fail('Use a file name, not a path');
  if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.md';
  const file = `${r}/${name}`,
    launcher = g.active;
  try {
    const exists = await H.read(file).then(
      () => true,
      () => false,
    );
    if (!exists) await H.write(file, '');
  } catch (e) {
    return fail((e as Error).message);
  }
  const lay = cur();
  if (lay && leafById(lay, g.id)) lay.lastFile = g.id;
  await openFile(file, { pin: true });
  if (launcher?.startsWith('n:')) removeKey(launcher);
}

// ------------------------------------------------------------------ launcher input wiring

/** onChange of the launcher input: track the query and rebuild the rows. */
export function lqChanged(g: Leaf, value: string) {
  const reg = groups.get(g.id);
  if (!reg) return;
  reg.lqText = value;
  reg.lsel = 0;
  renderLaunch(g);
}

interface LqKeyEvt {
  key: string;
  metaKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}
/** onKeyDown of the launcher input: ⌘A select-all, ctrl-n/p + arrow navigation, Enter, Esc. */
export function lqKeyDown(g: Leaf) {
  return (e: LqKeyEvt) => {
    const reg = groups.get(g.id);
    const lq = reg?.lq;
    if (!reg || !lq) return;
    if (e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      lq.select();
      return;
    } // no Select All menu role (see commitMsg in editor.js)
    const d =
      e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
        ? 1
        : e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
          ? -1
          : 0;
    if (d) {
      e.preventDefault();
      reg.lsel = Math.max(0, Math.min(reg.litems.length - 1, reg.lsel + d));
      renderLaunch(g);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (reg.lnaming) createMarkdown(g, reg.lqText);
      else runLaunch(g, reg.lsel);
    } else if (e.key === 'Escape' && (reg.lnaming || reg.lhist)) {
      e.stopPropagation();
      reg.lnaming = false;
      reg.lhist = null;
      setLq(reg, '');
      renderLaunch(g);
    }
  };
}

// ------------------------------------------------------------------ gc + fx

/** Forget DOM/editors of groups that no longer exist in any worktree's layout. */
function gc() {
  const live = new Set<string>();
  for (const g of everyLeaf()) live.add(g.id);
  for (const id of groups.keys()) {
    if (live.has(id)) continue;
    groups.delete(id);
    useGroupView.setState((s) => {
      const views = { ...s.views };
      delete views[id];
      return { views };
    });
    disposeGroup(id);
  }
}

/** The renderer's DOM effects, consumed by the store's actions. Runs synchronously on every
 * commit: openKey returns fx.pendingMount(g.id) synchronously, so syncShown must kick the
 * mount promise before openKey reads it. */
configureLayoutStore({
  renderRoot: () => {
    const r = L().root;
    const lay = r ? ensure(r) : null;
    if (lay) {
      // zoom ends when the pane goes away, is the only one left, or focus moves to another pane
      if (lay.zoom && (isLeaf(lay.tree) || lay.zoom !== lay.focus || !leafById(lay, lay.zoom))) lay.zoom = null;
      for (const g of leaves(lay.tree)) syncShown(g);
    }
    gc();
    bumpTick();
    if (lay) {
      groupFocused(lay.focus as string);
      markSidebar();
      requestAnimationFrame(() => fitAll());
    }
  },
  renderPageBar: () => bumpTick(),
  afterActivate,
  focusGroup,
  pendingMount: (gid) => groups.get(gid)?.pending ?? null,
  groupRect: (gid) => groups.get(gid)?.el?.getBoundingClientRect() ?? null,
  gc,
});

export function closeCurrentPage() {
  const { root, workspaces } = L();
  const ws = root ? workspaces.get(root) : undefined;
  if (ws) closePage(ws.at);
}

export function renameCurrentPage() {
  const { root, workspaces } = L();
  const ws = root ? workspaces.get(root) : undefined;
  if (ws) useUiTick.setState({ renamePageAt: ws.at });
}
