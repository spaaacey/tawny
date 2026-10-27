// Split-pane workspace: per worktree, a list of pages; each page is a tree of tab groups (panes). A tab is an agent ('a:<session id>'), a file ('f:<path>')
// a new-tab launcher ('n:<id>', replaced by whatever it starts) or a diff ('d:s:<path>' staged: HEAD↔index, 'd:w:<path>' unstaged: index↔working tree, 'd:c:<sha>:<path>' commit: parent↔commit).
// Tabs can be dragged between groups, reordered, dropped on a group's edge to split it, or dropped on a page chip to move to that page.
//
// This is the renderer: imperative DOM for panes, tab bars, the page bar, tab DnD and the
// launcher. The workspace model (pages, tree ops, persistence, session reconcile and the
// tab/page/zoom/focus actions) lives in layoutStore.ts; `harborLayout` is now a thin facade
// over it plus the DOM-only pieces below.
import type { Session } from '../../../shared/types';
import { track } from '../lib/dnd';
import { H } from '../lib/legacy';
import type { FileMatch } from './editor';
import type { Any, Leaf, Node, Page, Side, Split } from './layoutStore';
import {
  activate,
  activeFile,
  activeKey,
  closeActive,
  closeKey,
  closePage as closePageAt,
  configureLayoutStore,
  cur,
  currentAgent,
  cyclePage,
  cycleTab,
  diffKeys,
  ensure,
  everyLeaf,
  expectAgent,
  filesOf,
  firstLeaf,
  focusEditor,
  focusedGroup,
  forgetRoot,
  groupOf,
  hasFile,
  hasKey,
  initFromUi,
  isDirtyKey,
  isLeaf,
  leafById,
  leaves,
  mergeGroup,
  moveActive,
  movePage,
  moveTab,
  newPage,
  newTab,
  noteKind,
  openDiff,
  openFile,
  openKey,
  PAGE_COLORS,
  pageLabel,
  pages,
  persist,
  removeFile,
  removeKey,
  revealAgent,
  setPage,
  setPageColor,
  setPageName,
  setRoot,
  splitFocused,
  sync,
  toggleZoom,
  useLayoutStore,
  visibleAgents,
} from './layoutStore';

interface LaunchItem {
  kind?: boolean;
  html: string;
  run(): unknown;
}
interface GroupEl {
  el: HTMLElement;
  tabs: HTMLElement;
  body: HTMLElement;
  host: HTMLElement;
  diffHost: HTMLElement;
  binary: HTMLElement;
  image: HTMLElement;
  launch: HTMLElement;
  lsel: number;
  litems: LaunchItem[];
  lnaming: boolean;
  lhist: { items: { title?: string; updatedAt: string; sessionId: string }[] | null; error: string | null } | null;
  tok: number;
  mounted: string | null;
  pending: Promise<string | null> | null;
  html: string;
  shown: string | null;
}
type Drop =
  | { kind: 'page'; page: number; rect: number[] }
  | { kind: 'tab'; g: Leaf; index: number; bar: { x: number; top: number; h: number } }
  | { kind: 'edge'; g: Leaf; side: Side; rect?: number[] }
  | { kind: 'center'; g: Leaf; rect?: number[] };
type MenuItem = { label: string; run?(): void; sub?: MenuItem[]; color?: string };

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
const E = () => window.harborEditor;
const APP = () => window.harborApp;
const L = () => useLayoutStore.getState();
const MIN_PX = 140;
const EDGE = 0.25; // outer fraction of a group that splits it when dropped on
const X =
  '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
const PLUS =
  '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

const groupEls = new Map<string, GroupEl>(); // group id -> { el, tabs, body, host, binary, empty, tok, mounted, pending, html, shown }
let structSig = '';
let dragKey: string | null = null;

// ------------------------------------------------------------------ rendering

/** Tab label: user's name, else the agent's name / the terminal's running command. */
function agentLabel(info: Session | null) {
  if (!info) return 'agent';
  if (info.title) return info.title;
  if (info.kind === 'terminal') return info.proc || `terminal ${info.index}`;
  return info.name || `agent ${info.index}`;
}

/** Rename an agent tab inline (right-click → Rename); Enter saves, Esc cancels, empty resets to the default. */
function renameTab(t: HTMLElement) {
  const id = (t.dataset.key as string).slice(2),
    info = APP().agentInfo(id),
    span = t.querySelector('.tname');
  if (!info || !span || t.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'tname-edit';
  input.value = info.title || agentLabel(info);
  input.size = Math.max(6, input.value.length + 1);
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (save && v !== agentLabel(info))
      APP().renameAgent(id, v === (info.kind === 'terminal' ? info.proc : info.name) ? '' : v);
    input.replaceWith(span);
    renderTabs();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('input', () => {
    input.size = Math.max(6, input.value.length + 1);
  });
  input.addEventListener('blur', () => finish(true));
}

const waitDot = '<div class="dot wait" style="width:6px;height:6px"></div>';
const spinner = '<div class="spin" style="width:9px;height:9px;border-width:1.6px"></div>';

function tabHtml(k: string, g: Leaf) {
  const cls = `${k === g.active ? ' on' : ''}${k === dragKey ? ' dragging' : ''}`;
  const prev = k === g.preview && !isDirtyKey(k) ? ' preview' : '';
  if (k.startsWith('a:')) {
    const info = APP().agentInfo(k.slice(2));
    const ind = info?.waiting
      ? waitDot
      : info?.working
        ? spinner
        : '<div class="dot idle" style="width:6px;height:6px;box-shadow:none"></div>';
    return `<div class="gtab agent${cls}" data-key="${esc(k)}">${ind}<span class="tname">${esc(agentLabel(info))}</span><span class="gx" title="Stop agent">${X}</span></div>`;
  }
  if (k.startsWith('n:')) {
    return `<div class="gtab${cls}" data-key="${esc(k)}"><span class="tname">New tab</span><span class="gx" title="Close tab">${X}</span></div>`;
  }
  if (k.startsWith('d:')) {
    const info = E().diffInfo(k);
    return `<div class="gtab file diff${cls}${prev}" data-key="${esc(k)}" title="${esc(info.title)}">
        <span class="tname">${esc(info.name)}</span><span class="gx ${info.dirty ? 'dirty' : ''}">${info.dirty ? '●' : '×'}</span></div>`;
  }
  const p = k.slice(2);
  const info = E().tabInfo(p);
  return `<div class="gtab file${cls}${prev}${info.errs ? ' has-err' : ''}" data-key="${esc(k)}" title="${esc(info.title)}">
      <span class="tname">${esc(info.name)}</span>${info.conflict ? '<span class="tconf" title="Changed on disk while you had unsaved edits">!</span>' : ''}
      <span class="gx ${info.dirty ? 'dirty' : ''}">${info.dirty ? '●' : '×'}</span></div>`;
}

function groupEl(g: Leaf): GroupEl {
  const known = groupEls.get(g.id);
  if (known) return known;
  const el = document.createElement('div');
  el.className = 'group';
  el.dataset.id = g.id;
  el.innerHTML = `
      <div class="gbar"><div class="gtabs"></div><button class="icon-btn gnew" title="New tab (⌘N)">${PLUS}</button></div>
      <div class="gbody">
        <div class="ghost" hidden></div>
        <div class="gdiff" hidden></div>
        <div class="gimage" hidden><img alt=""></div>
        <div class="gbinary center-msg" hidden><div class="empty-title">Binary file</div><div>This file can't be shown as text.</div></div>
        <div class="glaunch center-msg" hidden>
          <div class="lbox">
            <input class="lq" spellcheck="false" autocomplete="off" aria-label="New tab">
            <div class="lopts"></div>
            <pre class="gerr" hidden></pre>
          </div>
        </div>
      </div>`;
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const ge: GroupEl = {
    el,
    tabs: q('.gtabs'),
    body: q('.gbody'),
    host: q('.ghost'),
    diffHost: q('.gdiff'),
    binary: q('.gbinary'),
    image: q('.gimage'),
    launch: q('.glaunch'),
    lsel: 0,
    litems: [],
    lnaming: false,
    lhist: null,
    tok: 0,
    mounted: null,
    pending: null,
    html: '',
    shown: null,
  };
  groupEls.set(g.id, ge);
  el.addEventListener('mousedown', () => setFocus(g.id), true);
  q('.gnew').onclick = () => {
    setFocus(g.id);
    newTab();
  };
  const lq = ge.launch.querySelector('.lq') as HTMLInputElement;
  lq.addEventListener('input', () => {
    ge.lsel = 0;
    renderLaunch(g);
  });
  lq.addEventListener('keydown', (e) => {
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
      ge.lsel = Math.max(0, Math.min(ge.litems.length - 1, ge.lsel + d));
      renderLaunch(g);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (ge.lnaming) createMarkdown(g, lq.value);
      else runLaunch(g, ge.lsel);
    } else if (e.key === 'Escape' && (ge.lnaming || ge.lhist)) {
      e.stopPropagation();
      ge.lnaming = false;
      ge.lhist = null;
      lq.value = '';
      renderLaunch(g);
    }
  });
  // a click on the launcher's empty space keeps the input focused so arrows/typing still work
  ge.launch.addEventListener('mousedown', (e) => {
    if (e.target !== lq && !(e.target as HTMLElement).closest('.lopt')) {
      e.preventDefault();
      lq.focus();
    }
  });
  (ge.launch.querySelector('.lopts') as HTMLElement).addEventListener('mousedown', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.lopt');
    if (!row) return;
    e.preventDefault();
    setFocus(g.id);
    runLaunch(g, Number(row.dataset.i));
  });
  ge.tabs.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.gtab');
    if (!t) return;
    const key = t.dataset.key as string;
    if ((e.target as HTMLElement).closest('.gx')) {
      e.stopPropagation();
      closeKey(key);
    } else activate(g, key);
  });
  // double-click a preview tab to keep it
  ge.tabs.addEventListener('dblclick', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.gtab');
    if (t && !(e.target as HTMLElement).closest('.gx, input') && g.preview === t.dataset.key) {
      g.preview = null;
      renderTabs();
    }
  });
  // double-click the empty part of the bar to zoom the pane
  q('.gbar').addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.gx, input, .gnew')) return;
    if (e.target === e.currentTarget || e.target === ge.tabs) toggleZoom();
  });
  ge.tabs.addEventListener('contextmenu', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.gtab.agent');
    if (!t) return;
    e.preventDefault();
    E().showContextMenu(e.clientX, e.clientY, [{ label: 'Rename', run: () => renameTab(t) }]);
  });
  q('.gbar').addEventListener('mousedown', (e) => {
    if (e.button === 0 && e.target === e.currentTarget && g.tabs.length) beginGroupDrag(e, g);
  });
  ge.tabs.addEventListener('mousedown', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('.gtab');
    if (!t || (e.target as HTMLElement).closest('input')) return;
    const key = t.dataset.key as string;
    if (e.button === 1) {
      e.preventDefault();
      closeKey(key);
      return;
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest('.gx')) return;
    beginDrag(e, key, t.querySelector('.tname')?.textContent || '');
  });
  return ge;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

async function mount(g: Leaf, ge: GroupEl, path: string) {
  const tok = ++ge.tok;
  const m = await E().show(g.id, ge.host, path);
  if (tok !== ge.tok) return g.id;
  if (!m || m.error) {
    ge.mounted = null;
    removeFile(path);
    return null;
  }
  ge.host.hidden = !m.model;
  const img = m.binary && IMAGE_EXT.test(path);
  if (img)
    (ge.image.firstChild as HTMLImageElement).src = `file://${encodeURI(path).replace(/[#?]/g, encodeURIComponent)}`;
  ge.image.hidden = !img;
  ge.binary.hidden = !m.binary || img;
  if (m.model) E().layoutGroup(g.id);
  return g.id;
}

async function mountDiff(g: Leaf, ge: GroupEl, key: string) {
  const tok = ++ge.tok;
  const m = await E().showDiff(g.id, ge.diffHost, key);
  if (tok !== ge.tok) return g.id;
  if (!m || m.error) {
    ge.mounted = null;
    removeKey(key);
    return null;
  }
  ge.diffHost.hidden = !!m.binary;
  ge.image.hidden = true;
  ge.binary.hidden = !m.binary;
  if (!m.binary) E().layoutGroup(g.id);
  return g.id;
}

function renderGroup(lay: Page, g: Leaf) {
  const ge = groupEl(g);
  ge.el.classList.toggle('focused', lay.focus === g.id);
  const html = g.tabs.map((k) => tabHtml(k, g)).join('');
  if (html !== ge.html && !ge.tabs.querySelector('input')) ge.tabs.innerHTML = ge.html = html;
  if (ge.shown !== g.active) {
    ge.shown = g.active;
    const on = ge.tabs.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  const act = g.active;
  for (const k of g.tabs) {
    if (!k.startsWith('a:')) continue;
    const el = APP().termEl(k.slice(2));
    if (el.parentNode !== ge.body) ge.body.appendChild(el);
    el.hidden = k !== act;
  }
  if (act?.startsWith('f:')) {
    ge.host.hidden = false;
    ge.diffHost.hidden = true;
    if (ge.mounted !== act) {
      ge.mounted = act;
      ge.pending = mount(g, ge, act.slice(2));
    }
  } else if (act?.startsWith('d:')) {
    ge.host.hidden = true;
    ge.diffHost.hidden = false;
    ge.image.hidden = true;
    if (ge.mounted !== act) {
      ge.mounted = act;
      ge.pending = mountDiff(g, ge, act);
    }
  } else {
    ge.mounted = null;
    ge.host.hidden = true;
    ge.diffHost.hidden = true;
    ge.image.hidden = true;
    ge.binary.hidden = true;
  }
  const launching = act ? act.startsWith('n:') : !!L().root; // an empty pane is a launcher too
  if (launching && ge.launch.hidden) {
    ge.lsel = 0;
    ge.lnaming = false;
    ge.lhist = null;
    (ge.launch.querySelector('.lq') as HTMLInputElement).value = '';
    renderLaunch(g);
  }
  ge.launch.hidden = !launching;
}

const sigOf = (n: Node): string => (isLeaf(n) ? n.id : `${n.dir}(${n.children.map(sigOf).join(',')})`);

function buildNode(n: Node): HTMLElement {
  if (isLeaf(n)) return groupEl(n).el;
  const el = document.createElement('div');
  el.className = `split ${n.dir}`;
  n.children.forEach((c, i) => {
    if (i) el.appendChild(splitter(n, i - 1, el));
    const ce = buildNode(c);
    ce.style.flex = `${n.sizes[i]} 1 0%`;
    el.appendChild(ce);
  });
  return el;
}

function splitter(n: Split, i: number, splitEl: HTMLElement) {
  const s = document.createElement('div');
  s.className = `gsplit ${n.dir}`;
  s.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const row = n.dir === 'row';
    const total = row ? splitEl.clientWidth : splitEl.clientHeight;
    const kids = [...splitEl.children].filter((x) => !x.classList.contains('gsplit')) as HTMLElement[];
    const a0 = n.sizes[i],
      b0 = n.sizes[i + 1],
      start = row ? e.clientX : e.clientY;
    const min = Math.min(MIN_PX / total, (a0 + b0) / 2);
    s.classList.add('drag-on');
    const mv = (ev: MouseEvent) => {
      const a = Math.max(min, Math.min(a0 + b0 - min, a0 + ((row ? ev.clientX : ev.clientY) - start) / total));
      n.sizes[i] = a;
      n.sizes[i + 1] = a0 + b0 - a;
      kids[i].style.flex = `${n.sizes[i]} 1 0%`;
      kids[i + 1].style.flex = `${n.sizes[i + 1]} 1 0%`;
    };
    const up = () => {
      removeEventListener('mousemove', mv, true);
      removeEventListener('mouseup', up, true);
      s.classList.remove('drag-on');
      persist();
    };
    addEventListener('mousemove', mv, true);
    addEventListener('mouseup', up, true);
  });
  return s;
}

function renderRoot(force?: boolean) {
  const c = $('#layoutRoot');
  const r = L().root;
  if (!r) {
    c.replaceChildren();
    structSig = '';
    gc();
    renderPageBar();
    return;
  }
  const lay = ensure(r);
  const sig = `${r}|${lay.id}|${sigOf(lay.tree)}`;
  if (force || sig !== structSig) {
    structSig = sig;
    const top = buildNode(lay.tree);
    top.style.flex = '1 1 0%';
    c.replaceChildren(top);
    for (const ge of groupEls.values()) ge.el.classList.remove('tl');
    groupEls.get(firstLeaf(lay).id)?.el.classList.add('tl');
    c.classList.toggle('multi', !isLeaf(lay.tree));
  }
  // zoom ends when the pane goes away, is the only one left, or focus moves to another pane
  if (lay.zoom && (isLeaf(lay.tree) || lay.zoom !== lay.focus || !leafById(lay, lay.zoom))) lay.zoom = null;
  c.classList.toggle('zoomed', !!lay.zoom);
  for (const [id, ge] of groupEls) ge.el.classList.toggle('zoomed', id === lay.zoom);
  for (const g of leaves(lay.tree)) renderGroup(lay, g);
  gc();
  renderPageBar();
  E().groupFocused(lay.focus as string);
  APP().markSidebar();
  requestAnimationFrame(() => APP().fitAll());
}

/** Forget DOM/editors of groups that no longer exist in any worktree's layout. */
function gc() {
  const live = new Set();
  for (const g of everyLeaf()) live.add(g.id);
  for (const [id, ge] of groupEls) {
    if (live.has(id)) continue;
    ge.el.remove();
    groupEls.delete(id);
    E().disposeGroup(id);
  }
}

/** Cheap refresh of tab labels (dirty / error marks, agent spinners). */
function renderTabs() {
  const lay = cur();
  if (!lay) return;
  for (const g of leaves(lay.tree)) {
    const ge = groupEls.get(g.id);
    if (!ge) continue;
    if (ge.tabs.querySelector('input')) continue; // renaming a tab
    const html = g.tabs.map((k) => tabHtml(k, g)).join('');
    if (html !== ge.html) ge.tabs.innerHTML = ge.html = html;
  }
  renderPageBar();
}

// ------------------------------------------------------------------ pages

let barHtml = '';

/** Strip of page chips under the panes; a chip shows a spinner / dot while an agent in that page works / waits. */
function renderPageBar() {
  const bar = $('#pageBar');
  const { root, workspaces } = L();
  const ws = root && workspaces.get(root);
  bar.hidden = !ws;
  if (!ws || bar.querySelector('input')) return;
  const html = `${ws.pages
    .map((p, i) => {
      const infos = [...leaves(p.tree)]
        .flatMap((g) => g.tabs)
        .filter((k) => k.startsWith('a:'))
        .map((k) => APP().agentInfo(k.slice(2)));
      const ind = infos.some((x) => x?.waiting) ? waitDot : infos.some((x) => x?.working) ? spinner : '';
      return `<div class="pchip${i === ws.at ? ' on' : ''}${p.color ? ' pc' : ''}" data-i="${i}" draggable="true"${p.color ? ` style="--pc:${p.color}"` : ''}>${ind}<span class="tname">${esc(pageLabel(p, i))}</span>${
        ws.pages.length > 1 ? `<span class="gx" title="Close page (tabs move to a neighbour)">${X}</span>` : ''
      }</div>`;
    })
    .join('')}<button class="icon-btn pnew" title="New page (⌥⇧⌘N)">${PLUS}</button>`;
  if (html !== barHtml) bar.innerHTML = barHtml = html;
}

function initBar() {
  const bar = $('#pageBar');
  bar.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.pnew')) return newPage();
    const c = t.closest<HTMLElement>('.pchip');
    if (!c || t.closest('input')) return;
    if (t.closest('.gx')) closePageAt(Number(c.dataset.i));
    else setPage(Number(c.dataset.i));
  });
  bar.addEventListener('dblclick', (e) => {
    const t = e.target as HTMLElement;
    const c = t.closest<HTMLElement>('.pchip');
    if (c && !t.closest('.gx, input')) renamePage(Number(c.dataset.i));
  });
  bar.addEventListener('mousedown', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
    if (e.button === 1 && c) {
      e.preventDefault();
      closePageAt(Number(c.dataset.i));
    }
  });
  // drag a chip to reorder pages; drop side of the hovered chip picks the slot
  let from = -1;
  const clearMarks = () => {
    for (const el of bar.querySelectorAll('.drop-before, .drop-after'))
      el.classList.remove('drop-before', 'drop-after');
  };
  const slot = (e: DragEvent) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const i = Number(c.dataset.i);
    return { c, to: e.clientX < r.left + r.width / 2 ? i : i + 1 };
  };
  bar.addEventListener('dragstart', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
    if (!c || (e.target as HTMLElement).closest('input')) return e.preventDefault();
    from = Number(c.dataset.i);
    c.classList.add('dragging');
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  bar.addEventListener('dragover', (e) => {
    if (from < 0) return;
    e.preventDefault();
    clearMarks();
    const sl = slot(e);
    if (sl && sl.to !== from && sl.to !== from + 1)
      sl.c.classList.add(sl.to === Number(sl.c.dataset.i) ? 'drop-before' : 'drop-after');
  });
  bar.addEventListener('drop', (e) => {
    e.preventDefault();
    const sl = slot(e);
    clearMarks();
    if (from < 0 || !sl) return;
    movePage(from, sl.to);
  });
  bar.addEventListener('dragend', () => {
    from = -1;
    clearMarks();
    bar.querySelector('.dragging')?.classList.remove('dragging');
  });
  bar.addEventListener('contextmenu', (e) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
    e.preventDefault();
    const i = c ? Number(c.dataset.i) : null;
    const items: MenuItem[] = [{ label: 'New Page', run: newPage }];
    if (i != null)
      items.unshift(
        { label: 'Rename', run: () => renamePage(i) },
        {
          label: 'Color',
          sub: [
            ...PAGE_COLORS.map((c) => ({ label: c.name, color: c.hex, run: () => setPageColor(i, c.hex) })),
            { label: 'None', run: () => setPageColor(i, '') },
          ],
        },
        { label: 'Close Page', run: () => closePageAt(i) },
      );
    E().showContextMenu(e.clientX, e.clientY, items);
  });
}

/** Rename a page chip inline; Enter saves, Esc cancels, empty resets to "Page N". */
function renamePage(i: number) {
  const { root, workspaces } = L();
  const ws = root ? workspaces.get(root) : undefined;
  const chip = $('#pageBar').querySelector(`.pchip[data-i="${i}"]`);
  const span = chip?.querySelector('.tname');
  if (!ws?.pages[i] || !chip || !span || chip.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'tname-edit';
  input.value = ws.pages[i].name || pageLabel(ws.pages[i], i);
  input.size = Math.max(6, input.value.length + 1);
  span.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const v = input.value.trim().slice(0, 60);
    input.replaceWith(span);
    if (save) setPageName(i, v === `Page ${i + 1}` ? '' : v);
    barHtml = '';
    renderPageBar();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('input', () => {
    input.size = Math.max(6, input.value.length + 1);
  });
  input.addEventListener('blur', () => finish(true));
}

// ------------------------------------------------------------------ focus

function setFocus(id: string | null) {
  const lay = cur();
  if (!lay || !leafById(lay, id)) return;
  lay.focus = id;
  for (const g of leaves(lay.tree)) groupEls.get(g.id)?.el.classList.toggle('focused', g.id === id);
  noteKind(lay, leafById(lay, id) as Leaf);
  E().groupFocused(id as string);
  APP().markSidebar();
}

function afterActivate(g: Leaf, key: string) {
  if (key.startsWith('a:')) APP().focusTerm(key.slice(2));
  else if (key.startsWith('n:')) (groupEls.get(g.id)?.launch.querySelector('.lq') as HTMLElement | null)?.focus();
  else E().focusGroup(g.id);
}

function focusGroup(g: Leaf) {
  setFocus(g.id);
  if (g.active) afterActivate(g, g.active);
  else (groupEls.get(g.id)?.launch.querySelector('.lq') as HTMLElement | null)?.focus();
}

/** Overlay a number on each visible pane; the digit pressed focuses that pane. Triggering again cycles to the next pane. */
let pickOff: (() => void) | null = null;
function pickPane() {
  const lay = cur();
  if (!lay) return;
  const rectOf = (g: Leaf) => (groupEls.get(g.id) as GroupEl).el.getBoundingClientRect();
  // visual order: rows top to bottom, left to right within a row
  const gs = [...leaves(lay.tree)]
    .filter((g) => {
      const r = groupEls.has(g.id) ? rectOf(g) : null;
      return r?.width && r.height;
    })
    .sort((a, b) => {
      const ra = rectOf(a),
        rb = rectOf(b);
      return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left;
    });
  if (gs.length < 2) return;
  if (pickOff) {
    const next = gs[(gs.findIndex((g) => g.id === lay.focus) + 1) % gs.length];
    pickOff();
    return focusGroup(next);
  }
  const badges = gs.slice(0, 9).map((g, i) => {
    const r = rectOf(g);
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

function beginDrag(e0: MouseEvent, key: string, label: string) {
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
      renderTabs();
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
      else renderTabs();
    },
  });
}

/** Drag a whole pane (grab the empty part of its tab bar) onto another pane to merge all its tabs into it. */
function beginGroupDrag(e0: MouseEvent, g: Leaf) {
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
function dragFile(e: MouseEvent, path: string, label: string) {
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
  const st = APP().settings() as {
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

/** Rebuild the launcher's rows: matching kinds, then files by fuzzy name, then "create <name>". */
function renderLaunch(g: Leaf) {
  const ge = groupEls.get(g.id);
  if (!ge) return;
  const lq = ge.launch.querySelector('.lq') as HTMLInputElement;
  const list = ge.launch.querySelector('.lopts') as HTMLElement;
  (ge.launch.querySelector('.gerr') as HTMLElement).hidden = true;
  if (ge.lnaming) {
    lq.placeholder = 'File name, e.g. notes.md';
    ge.litems = [];
    list.innerHTML = '<div class="lopt qi muted">Enter to create it in the worktree root · Esc to go back</div>';
    return;
  }
  if (ge.lhist) {
    lq.placeholder = 'Find a chat…';
    const q = lq.value.trim().toLowerCase();
    const h = ge.lhist;
    const rows = h.items ? h.items.filter((x) => !q || (x.title || 'Untitled chat').toLowerCase().includes(q)) : [];
    ge.litems = rows.map((x) => ({
      html: `<span>${esc(x.title || 'Untitled chat')}</span><span class="lhint">${esc(ago(x.updatedAt))}</span>`,
      run: () => APP().newAgent(g.id, 'chat', { sessionId: x.sessionId, title: x.title }),
    }));
    ge.lsel = Math.min(ge.lsel, Math.max(0, ge.litems.length - 1));
    list.innerHTML =
      ge.litems
        .map((it, i) => `<div class="lopt qi${i === ge.lsel ? ' sel' : ''}" data-i="${i}">${it.html}</div>`)
        .join('') ||
      `<div class="lopt qi muted">${h.error ? esc(h.error) : h.items ? 'No saved chats' : 'Loading…'}</div>`;
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  lq.placeholder = 'Terminal, Claude, Markdown, or a file name…';
  const raw = lq.value,
    q = raw.trim().toLowerCase();
  const items: LaunchItem[] = [...LAUNCH_KINDS.slice(0, 2), ...chatKinds(), ...LAUNCH_KINDS.slice(2)]
    .filter((x) => !q || x.alias.some((a) => a.startsWith(q)) || x.label.toLowerCase().includes(q))
    .map(
      (x): LaunchItem => ({
        kind: true,
        html: `<span>${esc(x.label)}</span>`,
        run: () =>
          x.k === 'md'
            ? askMarkdownName(g)
            : x.k === 'chat-history'
              ? askChatHistory(g)
              : APP().newAgent(g.id, x.k, x.agent ? { agent: x.agent } : undefined),
      }),
    );
  if (!E().fileIndexLoaded())
    E()
      .loadFileIndex()
      .then(() => {
        if (!ge.launch.hidden && !ge.lnaming) renderLaunch(g);
      });
  else {
    const files = E()
      .fileMatches(raw)
      .slice(0, !q ? 5 : items.length ? 4 : 8);
    for (const r of files as { f: string }[])
      items.push({ html: E().fileRowHtml(r), run: () => openFromLauncher(g, r) });
    const name = raw.trim();
    if (name && !items.some((it) => it.kind) && !/[/\\:]/.test(name) && !files.some((r: { f: string }) => r.f === name))
      items.push({ html: `<span>Create <b>${esc(name)}</b></span>`, run: () => createMarkdown(g, name) });
  }
  ge.litems = items;
  ge.lsel = Math.min(ge.lsel, Math.max(0, items.length - 1));
  list.innerHTML =
    items
      .map((it, i) => `<div class="lopt qi${i === ge.lsel ? ' sel' : ''}" data-i="${i}">${it.html}</div>`)
      .join('') || '<div class="lopt qi muted">No matches</div>';
  list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function runLaunch(g: Leaf, i: number) {
  const ge = groupEls.get(g.id);
  const it = ge?.litems[i];
  if (ge && it)
    Promise.resolve()
      .then(it.run)
      .catch((e: Error) => {
        const err = ge.launch.querySelector('.gerr') as HTMLElement;
        err.textContent = e.message;
        err.hidden = false;
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
  const ge = groupEls.get(g.id);
  if (!ge) return;
  const h: NonNullable<GroupEl['lhist']> = { items: null, error: null };
  ge.lhist = h;
  ge.lsel = 0;
  const lq = ge.launch.querySelector('.lq') as HTMLInputElement;
  lq.value = '';
  renderLaunch(g);
  lq.focus();
  try {
    h.items = (await H.chatSessions(L().root as string)) as typeof h.items;
  } catch (e) {
    h.error = (e as Error).message;
  }
  if (ge.lhist === h) renderLaunch(g);
}

/** Swap the launcher's rows for a file-name prompt. */
function askMarkdownName(g: Leaf) {
  const ge = groupEls.get(g.id);
  if (!ge) return;
  const lq = ge.launch.querySelector('.lq') as HTMLInputElement;
  ge.lnaming = true;
  lq.value = '';
  renderLaunch(g);
  lq.focus();
}
function newMarkdown() {
  const g = newTab();
  if (g) askMarkdownName(g);
}

/** Open an existing file in place of the launcher. */
async function openFromLauncher(g: Leaf, r: FileMatch) {
  const launcher = g.active,
    lay = cur();
  if (lay && leafById(lay, g.id)) lay.lastFile = g.id;
  await E().openFileResult(r);
  if (launcher?.startsWith('n:')) removeKey(launcher);
}

/** Create `name` (.md unless it has an extension) in the worktree root, open it in place of the launcher. An existing file is just opened. */
async function createMarkdown(g: Leaf, raw: string) {
  let name = raw.trim();
  const ge = groupEls.get(g.id);
  const r = L().root;
  if (!name || !r || !ge) return;
  const err = ge.launch.querySelector('.gerr') as HTMLElement;
  const fail = (msg: string) => {
    err.textContent = msg;
    err.hidden = false;
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
  await E().openFile(file, { pin: true });
  if (launcher?.startsWith('n:')) removeKey(launcher);
}

// ------------------------------------------------------------------ facade

/** The renderer's DOM effects, consumed by the store's actions. */
configureLayoutStore({
  renderRoot: (force) => renderRoot(force),
  renderPageBar,
  afterActivate,
  focusGroup,
  pendingMount: (gid) => groupEls.get(gid)?.pending ?? null,
  groupRect: (gid) => groupEls.get(gid)?.el.getBoundingClientRect() ?? null,
  gc,
});

function init(ui: Any) {
  initFromUi(ui);
  initBar();
}

export const harborLayout = {
  init,
  setRoot,
  sync,
  renderTabs,
  agentLabel,
  openFile,
  removeFile,
  revealAgent,
  currentAgent,
  visibleAgents,
  activeFile,
  focusEditor,
  hasFile,
  hasKey,
  openKey,
  filesOf,
  diffKeys,
  forgetRoot,
  dragFile,
  openDiff,
  removeKey,
  activeKey,
  moveActive,
  cycleTab,
  toggleZoom,
  pickPane,
  splitFocused,
  newTab,
  newMarkdown,
  newPage,
  closePage: () => {
    const { root, workspaces } = L();
    const ws = root ? workspaces.get(root) : undefined;
    if (ws) closePageAt(ws.at);
  },
  renamePage: () => {
    const { root, workspaces } = L();
    const ws = root ? workspaces.get(root) : undefined;
    if (ws) renamePage(ws.at);
  },
  cyclePage,
  setPage,
  pages,
  focusGroup: setFocus,
  focusedGroup,
  expectAgent,
  closeActive,
};

window.harborLayout = harborLayout;
