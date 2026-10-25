'use strict';
/* global Terminal, FitAddon, WebglAddon */
const H = window.harbor;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = { repos: [], sessions: [], active: null, editor: { state: 'stopped' }, settings: {}, ui: {} };
const terms = new Map();        // session id -> { term, fit, el, ready, pending }
const collapsed = new Set();

if (navigator.platform.toUpperCase().includes('MAC')) document.body.classList.add('mac');
if (H.dev) { document.body.classList.add('dev'); $('#devBanner').hidden = false; document.title = 'Harbor (dev)'; }

// ---------------------------------------------------------------- helpers

const allWts = () => S.repos.flatMap(r => r.worktrees.map(w => ({ ...w, repoName: r.name })));
const activeWt = () => allWts().find(w => w.path === S.active);
const sessFor = w => S.sessions.filter(s => s.prefix === w.prefix).sort((a, b) => a.index - b.index);
const label = w => w.branch || (w.detached ? `detached ${w.head.slice(0, 7)}` : w.path.split('/').pop());

const ICON = {
  chev: window.harborChevron,
  plus: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
};

// ---------------------------------------------------------------- sidebar

function renderSidebar() {
  const root = $('#repos');
  if (!S.repos.length) {
    root.innerHTML = `<div class="center-msg" style="position:static;padding:40px 12px">
      <div class="empty-title">No repositories</div>
      <button class="primary-btn" id="firstRepo">Add repository</button></div>`;
    $('#firstRepo').onclick = addRepo;
    return;
  }
  let n = 0;
  root.innerHTML = S.repos.map(r => `
    <div class="repo ${collapsed.has(r.path) ? 'collapsed' : ''}" data-repo="${esc(r.path)}">
      <div class="repo-head">
        <span class="toggle">${ICON.chev}</span>
        <span class="name toggle" title="${esc(r.path)}">${esc(r.name)}</span>
        <span class="acts">
          <button class="icon-btn" data-act="new" title="New worktree">${ICON.plus}</button>
          <button class="icon-btn danger" data-act="remove" title="Remove from Harbor (files untouched)">${ICON.x}</button>
        </span>
      </div>
      ${r.error ? `<div class="repo-err">${esc(r.error)}</div>` : ''}
      <div class="wts">${r.worktrees.map(w => {
        const all = sessFor(w), ss = all.filter(s => s.kind !== 'terminal'), working = ss.filter(s => s.working).length, waiting = ss.filter(s => s.waiting).length, k = ++n;
        const ind = waiting ? '<div class="dot wait"></div>' : working ? '<div class="spin"></div>' : ss.length ? '<div class="dot idle"></div>' : '<div class="dot none"></div>';
        const meta = [];
        if (w.main) meta.push('<span>main</span>');
        if (waiting) meta.push(`<span class="needs">${waiting === 1 && ss.length === 1 ? 'needs input' : `${waiting}/${ss.length} need input`}</span>`);
        else if (ss.length) meta.push(working ? `<span class="work">${working === 1 && ss.length === 1 ? 'working' : `${working}/${ss.length} working`}</span>` : `<span>${ss.length} agent${ss.length > 1 ? 's' : ''}</span>`);
        if (w.prunable) meta.push('<span style="color:var(--danger)">missing</span>');
        const sessions = all.map(s => `<div class="st" data-path="${esc(w.path)}" data-id="${esc(s.id)}" title="${esc(s.kind === 'terminal' ? 'Terminal' : 'Agent')}">
          <div class="ind">${s.kind === 'terminal' ? '<span class="tglyph">&gt;_</span>' : s.waiting ? '<div class="dot wait"></div>' : s.working ? '<div class="spin"></div>' : '<div class="dot idle"></div>'}</div>
          <div class="br">${esc(window.harborLayout.agentLabel(s))}</div></div>`).join('');
        return `<div class="wt ${w.path === S.active ? 'active' : ''}" data-path="${esc(w.path)}" title="${esc(w.path)}">
          <div class="ind">${ind}</div>
          <div class="lbl"><div class="br">${esc(label(w))}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
          <div class="right">${k <= 9 ? `<span class="key">⌥⌘${k}</span>` : ''}
            ${w.main ? '' : `<button class="icon-btn danger del" data-act="del" title="Delete worktree">${ICON.trash}</button>`}</div>
        </div>${sessions}`;
      }).join('')}</div>
    </div>`).join('');

  root.querySelectorAll('.repo').forEach(el => {
    const repo = el.dataset.repo;
    el.querySelectorAll('.toggle').forEach(t => t.onclick = () => {
      collapsed.has(repo) ? collapsed.delete(repo) : collapsed.add(repo);
      el.classList.toggle('collapsed');
    });
    el.querySelector('[data-act=new]').onclick = e => { e.stopPropagation(); openNewWorktree(repo); };
    el.querySelector('[data-act=remove]').onclick = async e => {
      e.stopPropagation();
      if (confirm(`Remove ${repo.split('/').pop()} from Harbor?\n\nNothing on disk is deleted.`)) await H.removeRepo(repo);
    };
  });
  markSidebar();
  root.querySelectorAll('.st').forEach(el => {
    el.onclick = async () => {
      await activate(el.dataset.path);
      window.harborLayout.revealAgent(el.dataset.id);
      focusTerm(el.dataset.id);
    };
  });
  root.querySelectorAll('.wt').forEach(el => {
    el.onclick = () => activate(el.dataset.path);
    const del = el.querySelector('[data-act=del]');
    if (del) del.onclick = e => { e.stopPropagation(); deleteWorktree(el.dataset.path); };
  });
}

/** Highlight sidebar rows whose tab is showing in a pane. */
function markSidebar() {
  const vis = new Set(window.harborLayout.visibleAgents());
  document.querySelectorAll('#repos .st').forEach(el => el.classList.toggle('on', vis.has(el.dataset.id)));
}

// ---------------------------------------------------------------- header / editor

function renderHeader() {
  const env = [];
  if (!S.tmux) env.push(S.platform === 'win32' ? 'no tmux on Windows' : 'tmux not found — agents stop with Harbor');
  $('#envNote').textContent = env.join(' · ');
}

// ---------------------------------------------------------------- drag & drop

function setSidebarSide(side) {
  $('#app').classList.toggle('sidebar-right', side === 'right');
}
const sidebarSide = () => ($('#app').classList.contains('sidebar-right') ? 'right' : 'left');
window.harborDnd.dock($('.side-head .brand'), $('#app'), {
  getSide: sidebarSide,
  setSide: side => { setSidebarSide(side); H.saveUi({ sidebarSide: side }); },
});

// ---------------------------------------------------------------- agents

const PATH_RE = /(?:~\/|\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+-]+)*(?::\d+){0,2}/g;

function getTerm(id) {
  let t = terms.get(id);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;     // the layout moves it into whichever group holds the agent's tab
  $('#termHold').appendChild(el);
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace', fontSize: 13,
    theme: window.harborTheme.xterm(), cursorBlink: true, scrollback: 10000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* falls back to the DOM renderer */ }
  // replayed scrollback holds old terminal queries (DA1/DA2/DECRQM from tmux); answering
  // them again would leak the replies into the shell as typed text
  let replaying = true;
  term.onData(d => { if (!replaying) H.writeAgent(id, d); });
  term.onResize(({ cols, rows }) => H.resizeAgent(id, cols, rows));
  // ⌘K clears, ⌘←/→ line nav like a normal mac terminal
  // xterm.js: returning false means "handled, skip default"
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (e.metaKey && e.altKey) return false;   // app shortcuts (menu accelerators), not terminal input
    if (e.metaKey && e.key === 'k') { term.clear(); return false; }
    if (e.metaKey && e.key === 'ArrowLeft') { H.writeAgent(id, '\x01'); return false; }
    if (e.metaKey && e.key === 'ArrowRight') { H.writeAgent(id, '\x05'); return false; }
    if (e.metaKey && e.key === 'Backspace') { H.writeAgent(id, '\x15'); return false; }
    return true;
  });
  // ⌘-click a file path in the output (optionally :line:col) to open it in the editor
  const cwdOf = () => {
    const prefix = S.sessions.find(x => x.id === id)?.prefix;
    return allWts().find(w => w.prefix === prefix)?.path || activeWt()?.path;
  };
  const resolved = new Map();   // "cwd\0text" -> Promise<absolute path | null>
  const resolve = text => {
    const cwd = cwdOf(), key = `${cwd}\0${text}`;
    if (!resolved.has(key)) {
      if (resolved.size > 500) resolved.clear();
      resolved.set(key, H.resolveFile(cwd, text).catch(() => null));
    }
    return resolved.get(key);
  };
  term.registerLinkProvider({
    async provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true);
      if (!line) return cb(undefined);
      const links = [];
      for (const m of line.matchAll(PATH_RE)) {
        const text = m[0].replace(/[.,;:)\]]+$/, '');
        if (!text.includes('/') && !/\.\w+$/.test(text)) continue;
        const [, file, ln, col] = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(text);
        const abs = await resolve(file);
        if (!abs) continue;
        links.push({
          range: { start: { x: m.index + 1, y }, end: { x: m.index + text.length + 1, y } },
          text,
          activate: (e) => {
            if (!e.metaKey) return;
            window.harborEditor.openFile(abs, ln ? { selection: { lineNumber: +ln, column: +(col || 1) } } : {});
          },
        });
      }
      cb(links.length ? links : undefined);
    },
  });
  t = { term, fit, el, ready: false, pending: [] };
  terms.set(id, t);
  new ResizeObserver(() => fitTerm(t)).observe(el);
  H.agentBuffer(id).then(buf => {
    const live = () => {
      replaying = false;
      for (const d of t.pending) term.write(d);
      t.pending = [];
      t.ready = true;
    };
    if (buf) term.write(buf, live); else live();
  });
  // drop files from Finder/editor -> paste their paths
  el.addEventListener('dragover', e => e.preventDefault());
  el.addEventListener('drop', e => {
    e.preventDefault();
    const files = [...(e.dataTransfer.files || [])].map(f => H.pathFor(f)).filter(Boolean);
    const txt = files.length ? files.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(' ') : e.dataTransfer.getData('text/plain');
    if (txt) H.writeAgent(id, txt + ' ');
    term.focus();
  });
  return t;
}

H.onAgentData((id, d) => {
  const t = terms.get(id);
  if (!t) return;
  if (t.ready) t.term.write(d); else t.pending.push(d);
});
H.onAgentExit(id => {
  const t = terms.get(id);
  if (t) { t.term.dispose(); t.el.remove(); terms.delete(id); }
});

function fitTerm(t) {
  if (!t || t.el.hidden || !t.el.offsetWidth) return;
  try { t.fit.fit(); } catch { /* not ready */ }
}
function fitAll() { for (const t of terms.values()) fitTerm(t); }

function focusAgent() {
  const id = window.harborLayout.currentAgent();
  if (id) { window.harborLayout.revealAgent(id); focusTerm(id); }
  else document.querySelector('.gstart:not([hidden])')?.focus();
}
function focusTerm(id) { requestAnimationFrame(() => terms.get(id)?.term.focus()); }

/** Start an agent (or a plain terminal) as a tab in group `gid` (default: the focused group). */
async function newAgent(gid, kind = 'agent') {
  const w = activeWt();
  if (!w) return;
  const Lay = window.harborLayout;
  Lay.expectAgent(typeof gid === 'string' ? gid : Lay.focusedGroup());
  let id;
  try { id = await H.createAgent(w.path, kind); }
  catch (e) { toast(`Agent failed to start: ${e.message}`, 8000); await refreshState(); Lay.expectAgent(null); return; }
  await refreshState();
  Lay.expectAgent(null);
  Lay.revealAgent(id);
  focusTerm(id);
}

async function stopAgent(id) { await H.killAgent(id); }

// ---------------------------------------------------------------- actions

async function activate(p) {
  if (p === S.active) return;
  S.active = p;
  renderAll();
  try { await H.activate(p); } catch (e) { toast(e.message); }
}

async function addRepo() {
  try { await H.addRepo(); } catch (e) { alert(e.message); }
}
$('#addRepo').onclick = addRepo;
$('#settingsBtn').onclick = () => H.openSettings();

async function deleteWorktree(p) {
  const w = allWts().find(x => x.path === p);
  if (!w) return;
  const ss = sessFor(w);
  if (!confirm(`Delete worktree "${label(w)}"?\n\n${w.path}\n${ss.length ? `${ss.length} agent(s) will be stopped. ` : ''}The branch is kept.`)) return;
  const forget = () => E.forgetRoot(p);
  try { await H.deleteWorktree({ path: p }); forget(); }
  catch (e) {
    if (/modified|untracked|dirty|locked/i.test(e.message) && confirm(`It has uncommitted changes:\n${e.message}\n\nDelete anyway?`)) {
      try { await H.deleteWorktree({ path: p, force: true }); forget(); } catch (e2) { alert(e2.message); }
    } else if (!/modified|untracked|dirty|locked/i.test(e.message)) alert(e.message);
  }
}

function showOverlay(el) {
  for (const o of document.querySelectorAll('.overlay')) if (o !== el) o.hidden = true;
  el.hidden = false;
}
function hideOverlay(el) { el.hidden = true; }

function toast(msg, ms = 4000) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/** Type text into the current worktree's agent (or agent `id`), starting one if needed. */
async function sendToAgent(text, id) {
  const w = activeWt();
  if (!w) return;
  id = id || window.harborLayout.currentAgent();
  if (!id) { await newAgent(); await new Promise(r => setTimeout(r, 2500)); id = window.harborLayout.currentAgent(); }
  if (!id) return;
  H.writeAgent(id, text);
  window.harborLayout.revealAgent(id);
  focusTerm(id);
}

/** Like sendToAgent, but with several agents in the worktree asks which one (palette in pick mode). */
function pickAgent(text) {
  const w = activeWt();
  if (!w) return;
  const agents = sessFor(w).filter(s => s.kind === 'agent');
  if (agents.length < 2) return sendToAgent(text);
  pPick = { text, agents };
  pPrev = document.activeElement;
  showOverlay($('#paletteBack'));
  $('#paletteInput').value = '';
  const cur = agents.findIndex(s => s.id === window.harborLayout.currentAgent());
  pSel = Math.max(0, cur);
  renderPalette();
  $('#paletteInput').focus();
}

window.harborApp = {
  openPalette: initial => openPalette(initial),
  showOverlay, hideOverlay, toast, sendToAgent, pickAgent, newAgent, stopAgent, fitAll, focusTerm,
  termEl: id => getTerm(id).el,
  renameAgent: (id, title) => H.renameAgent(id, title),
  markSidebar,
  state: () => S,
  revealSession: async (p, id) => { await activate(p); window.harborLayout.revealAgent(id); focusTerm(id); },
  agentInfo: id => S.sessions.find(x => x.id === id) || null,
  agentHint: () => ({ hint: S.settings.agentCommand ? `$ ${S.settings.agentCommand}` : '', error: S.agentError || '' }),
};
H.onToast(m => toast(m, 6000));

async function openNewWorktree(repo) {
  if (!S.repos.length) return addRepo();
  repo = repo || activeWt()?.repo || S.repos[0].path;
  const sel = $('#wtRepo');
  sel.innerHTML = S.repos.map(r => `<option value="${esc(r.path)}" ${r.path === repo ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  $('#repoRow').hidden = S.repos.length < 2;
  $('#wtBranch').value = '';
  $('#wtErr').textContent = '';
  $('#wtBase').value = '';
  showOverlay($('#modalBack'));
  $('#wtBranch').focus();
  const fillBase = async () => { try { $('#wtBase').value = await H.currentBranch(sel.value); } catch { /* */ } };
  sel.onchange = fillBase;
  fillBase();
}
$('#wtCancel').onclick = () => hideOverlay($('#modalBack'));
$('#modalBack').addEventListener('mousedown', e => { if (e.target.id === 'modalBack') hideOverlay($('#modalBack')); });
$('#wtForm').onsubmit = async e => {
  e.preventDefault();
  const branch = $('#wtBranch').value.trim();
  if (!/^[^\s~^:?*[\\]+$/.test(branch) || branch.includes('..')) { $('#wtErr').textContent = 'Invalid branch name'; return; }
  $('#wtOk').disabled = true; $('#wtOk').textContent = 'Creating…';
  try {
    const startAgent = $('#wtAgent').checked;
    const p = await H.createWorktree({ repo: $('#wtRepo').value, branch, base: $('#wtBase').value.trim(), startAgent });
    S.active = p;
    hideOverlay($('#modalBack'));
    if (startAgent) setTimeout(focusAgent, 400);
  } catch (err) { $('#wtErr').textContent = err.message; }
  finally { $('#wtOk').disabled = false; $('#wtOk').textContent = 'Create'; }
};

// quick switcher
let qSel = 0, qItems = [];
function openQuick() {
  showOverlay($('#quickBack'));
  $('#quickInput').value = '';
  renderQuick();
  $('#quickInput').focus();
}
function renderQuick() {
  const q = $('#quickInput').value.toLowerCase();
  qItems = allWts().filter(w => !q || `${label(w)} ${w.repoName}`.toLowerCase().includes(q));
  qSel = Math.min(qSel, Math.max(0, qItems.length - 1));
  $('#quickList').innerHTML = qItems.map((w, i) => {
    const ss = sessFor(w), working = ss.some(s => s.working), waiting = ss.some(s => s.waiting);
    return `<div class="qi ${i === qSel ? 'sel' : ''}" data-i="${i}">
      ${waiting ? '<div class="dot wait"></div>' : working ? '<div class="spin"></div>' : ss.length ? '<div class="dot idle"></div>' : '<div class="dot none"></div>'}
      <span>${esc(label(w))}</span><span class="r">${esc(w.repoName)}${w.path === S.active ? ' · open' : ''}</span></div>`;
  }).join('') || '<div class="qi" style="color:var(--faint)">No matches</div>';
  $('#quickList').querySelectorAll('.qi[data-i]').forEach(el => el.onclick = () => pickQuick(+el.dataset.i));
}
function pickQuick(i) { const w = qItems[i]; hideOverlay($('#quickBack')); if (w) activate(w.path); }
$('#quickInput').addEventListener('input', () => { qSel = 0; renderQuick(); });
$('#quickInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { qSel = Math.min(qItems.length - 1, qSel + 1); renderQuick(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { qSel = Math.max(0, qSel - 1); renderQuick(); e.preventDefault(); }
  else if (e.key === 'Enter') pickQuick(qSel);
  else if (e.key === 'Escape') hideOverlay($('#quickBack'));
});
$('#quickBack').addEventListener('mousedown', e => { if (e.target.id === 'quickBack') hideOverlay($('#quickBack')); });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!$('#modalBack').hidden) hideOverlay($('#modalBack'));
});

// command palette (cmd+shift+p): every menu / shortcut action, plus the ones that only exist here
const Lay = () => window.harborLayout;
const COMMANDS = [
  ['File', 'Go to File…', '⌘P', () => E.openQuickOpen()],
  ['File', 'Save', '⌘S', () => E.save()],
  ['File', 'Close Tab', '⌘W', () => Lay().closeActive()],
  ['File', 'Add Repository…', '', () => addRepo()],
  ['File', 'New Worktree…', '⌥⌘N', () => openNewWorktree()],
  ['File', 'Open Worktree in VS Code', '⌥⌘O', () => S.active && H.openDesktop(S.active)],
  ['File', 'Reveal Worktree in Finder', '', () => S.active && H.reveal(S.active)],
  ['File', 'Open Settings (harbor.json)', '⌘,', () => H.openSettings()],
  ['Go', 'Switch Worktree…', '⌥⌘P', () => openQuick()],
  ['Go', 'Previous Worktree', '⌥⌘↑', () => cycleWt(-1)],
  ['Go', 'Next Worktree', '⌥⌘↓', () => cycleWt(1)],
  ['Go', 'Focus Editor', '⌥⌘E', () => Lay().focusEditor() || E.openQuickOpen()],
  ['Go', 'Focus Agent', '⌥⌘A', () => focusAgent()],
  ['Go', 'Focus Pane…', '⌘J', () => Lay().pickPane()],
  ['Go', 'Previous Tab', '⌥⌘←', () => Lay().cycleTab(-1)],
  ['Go', 'Next Tab', '⌥⌘→', () => Lay().cycleTab(1)],
  ['Agent', 'New Agent', '⌥⌘T', () => newAgent()],
  ['Agent', 'New Terminal', '', () => newAgent(undefined, 'terminal')],
  ['Page', 'New Page', '⌥⇧⌘N', () => Lay().newPage()],
  ['Page', 'Close Page', '', () => Lay().closePage()],
  ['Page', 'Rename Page', '', () => Lay().renamePage()],
  ['Page', 'Previous Page', '⌥⌘[', () => Lay().cyclePage(-1)],
  ['Page', 'Next Page', '⌥⌘]', () => Lay().cyclePage(1)],
  ['Pane', 'Split Pane Right', '', () => Lay().splitFocused('right')],
  ['Pane', 'Split Pane Down', '', () => Lay().splitFocused('bottom')],
  ['Pane', 'Move Tab to Previous Pane', '⌥⇧⌘←', () => Lay().moveActive(-1)],
  ['Pane', 'Move Tab to Next Pane', '⌥⇧⌘→', () => Lay().moveActive(1)],
  ['Pane', 'Move Tab to Pane Above', '⌥⇧⌘↑', () => Lay().moveActive('up')],
  ['Pane', 'Move Tab to Pane Below', '⌥⇧⌘↓', () => Lay().moveActive('down')],
  ['Pane', 'Toggle Pane Zoom', '⌥⌘↵', () => Lay().toggleZoom()],
  ['Debug', 'Start Debugging', 'F5', () => window.harborDebug.start()],
  ['Debug', 'Stop Debugging', '⇧F5', () => window.harborDebug.stop()],
  ['Debug', 'Continue', 'F5', () => window.harborDebug.cont()],
  ['Debug', 'Pause', '', () => window.harborDebug.pause()],
  ['Debug', 'Step Over', 'F10', () => window.harborDebug.step('next')],
  ['Debug', 'Step Into', 'F11', () => window.harborDebug.step('stepIn')],
  ['Debug', 'Step Out', '⇧F11', () => window.harborDebug.step('stepOut')],
  ['Debug', 'Toggle Breakpoint', 'F9', () => window.harborDebug.toggleBreakpoint()],
  ['Debug', 'Add Conditional Breakpoint…', '', () => window.harborDebug.condBreakpoint('condition')],
  ['Debug', 'Add Logpoint…', '', () => window.harborDebug.condBreakpoint('logMessage')],
  ['Debug', 'Remove All Breakpoints', '', () => window.harborDebug.removeAll()],
  ['Debug', 'Toggle Debug Panel', '', () => window.harborDebug.togglePanel()],
  ['View', 'Toggle Workspaces Sidebar', '⌘B', () => $('#app').classList.toggle('no-sidebar')],
  ['View', 'Move Workspaces Sidebar to Other Side', '', () => { const s = sidebarSide() === 'left' ? 'right' : 'left'; setSidebarSide(s); H.saveUi({ sidebarSide: s }); }],
  ['View', 'Toggle Secondary Sidebar (File Tree)', '⌥⌘B', () => E.toggleTree()],
  ['View', 'Show Files in Secondary Sidebar', '', () => E.showFiles()],
  ['View', 'Show Source Control in Secondary Sidebar', '^⇧G', () => E.showChanges()],
  ['View', 'Move Secondary Sidebar to Other Side', '', () => E.moveTreeSide()],
  ['View', 'Toggle Resource Manager', '', () => window.harborStatus.toggle()],
  ['View', 'Toggle Rich Markdown', '⇧⌘M', () => E.toggleRich()],
  ['View', 'Restart Language Servers', '', () => { for (const k of ['ts', 'ruby']) H.lspRestart(S.active, k).catch(() => {}); }],
  ['View', 'Reload Window', '⇧⌘R', () => H.runMenu('reload')],
  ['View', 'Developer Tools', '⌥⌘I', () => H.runMenu('devtools')],
  ['View', 'Zoom In', '⌘=', () => H.runMenu('zoomIn')],
  ['View', 'Zoom Out', '⌘-', () => H.runMenu('zoomOut')],
  ['View', 'Actual Size', '⌘0', () => H.runMenu('zoomReset')],
].map(([cat, title, keys, run]) => ({ cat, title, keys, run }));
function cycleWt(d) { const list = allWts(); const i = list.findIndex(w => w.path === S.active); if (list.length) activate(list[(i + d + list.length) % list.length].path); }

// one input, two modes: '>' prefix = commands, otherwise go to file (like VS Code)
let pItems = [], pSel = 0, pPrev = null, pPick = null;   // pPick: choosing an agent to send `text` to
function openPalette(initial = '>') {
  pPick = null;
  pPrev = document.activeElement;
  showOverlay($('#paletteBack'));
  $('#paletteInput').value = initial;
  pSel = 0;
  renderPalette();
  $('#paletteInput').focus();
}
function closePalette(restore = true) {
  pPick = null;
  hideOverlay($('#paletteBack'));
  if (restore && pPrev && pPrev.isConnected) pPrev.focus();
  pPrev = null;
}
function renderPalette() {
  const raw = $('#paletteInput').value;
  const cmdMode = raw.startsWith('>');
  $('#paletteInput').placeholder = pPick ? 'Send to which agent…' : cmdMode ? 'Type a command…' : 'Go to file…   (name:line works too; type > for commands)';
  let rows;
  if (pPick) {
    const q = raw.toLowerCase().trim(), { text } = pPick, now = window.harborLayout.currentAgent();
    pItems = pPick.agents
      .filter(a => !q || window.harborLayout.agentLabel(a).toLowerCase().includes(q))
      .map(a => ({
        run: () => sendToAgent(text, a.id),
        title: window.harborLayout.agentLabel(a),
        html: `${a.waiting ? '<div class="dot wait"></div>' : a.working ? '<div class="spin"></div>' : '<div class="dot idle"></div>'}<span>${esc(window.harborLayout.agentLabel(a))}</span>${a.id === now ? '<kbd>current</kbd>' : ''}`,
      }));
    rows = 'No matching agents';
  } else if (cmdMode) {
    const words = raw.slice(1).toLowerCase().split(/\s+/).filter(Boolean);
    pItems = COMMANDS
      .map(c => {
        const hay = `${c.cat}: ${c.title}`.toLowerCase();
        let score = 0;
        for (const w of words) {
          const at = hay.indexOf(w);
          if (at < 0) return null;
          score += at;
        }
        return { c, score };
      })
      .filter(Boolean);
    if (words.length) pItems.sort((a, b) => a.score - b.score);   // stable: ties keep menu order
    pItems = pItems.map(x => ({ run: x.c.run, title: x.c.title, html: `<span><span class="cat">${esc(x.c.cat)}: </span>${esc(x.c.title)}</span>${x.c.keys ? `<kbd>${esc(x.c.keys)}</kbd>` : ''}` }));
    rows = 'No matching commands';
  } else if (!E.fileIndexLoaded()) {
    pItems = [];
    rows = 'Indexing…';
    E.loadFileIndex().then(() => { if (!$('#paletteBack').hidden && !$('#paletteInput').value.startsWith('>')) renderPalette(); });
  } else {
    pItems = E.fileMatches(raw).map(r => ({ run: () => E.openFileResult(r), title: r.f, html: E.fileRowHtml(r) }));
    rows = 'No matching files';
  }
  pSel = Math.min(pSel, Math.max(0, pItems.length - 1));
  $('#paletteList').innerHTML = pItems.map((c, i) =>
    `<div class="qi ${i === pSel ? 'sel' : ''}" data-i="${i}">${c.html}</div>`
  ).join('') || `<div class="qi muted">${rows}</div>`;
  $('#paletteList').querySelector('.qi.sel')?.scrollIntoView({ block: 'nearest' });
  $('#paletteList').querySelectorAll('.qi[data-i]').forEach(el => el.onmousedown = e => { e.preventDefault(); runPalette(+el.dataset.i); });
}
function runPalette(i) {
  const c = pItems[i];
  closePalette();
  if (c) Promise.resolve().then(c.run).catch(e => toast(`${c.title}: ${e.message}`));
}
$('#paletteInput').addEventListener('input', () => { pSel = 0; renderPalette(); });
$('#paletteInput').addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { pSel = Math.min(pItems.length - 1, pSel + 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { pSel = Math.max(0, pSel - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') runPalette(pSel);
  else if (e.key === 'Escape') closePalette();
});
$('#paletteBack').addEventListener('mousedown', e => { if (e.target.id === 'paletteBack') closePalette(); });

H.onMenu((cmd, arg) => {
  const list = allWts();
  switch (cmd) {
    case 'addRepo': return addRepo();
    case 'newWorktree': return openNewWorktree();
    case 'palette': return openPalette();
    case 'quickSwitch': return openQuick();
    case 'cycle': return cycleWt(arg);
    case 'jump': if (list[arg]) activate(list[arg].path); return;
    case 'focusAgent': return focusAgent();
    case 'newAgent': return newAgent();
    case 'toggleRich': return E.toggleRich();
    case 'toggleSidebar': return $('#app').classList.toggle('no-sidebar');
    case 'goToFile': return E.openQuickOpen();
    case 'save': return E.save();
    case 'closeTab': return window.harborLayout.closeActive();
    case 'moveTab': return window.harborLayout.moveActive(arg);
    case 'togglePaneZoom': return window.harborLayout.toggleZoom();
    case 'pickPane': return window.harborLayout.pickPane();
    case 'cycleTab': return window.harborLayout.cycleTab(arg);
    case 'newPage': return window.harborLayout.newPage();
    case 'cyclePage': return window.harborLayout.cyclePage(arg);
    case 'focusEditor': return window.harborLayout.focusEditor() || E.openQuickOpen();
    case 'toggleTree': return E.toggleTree();
    case 'showChanges': return E.showChanges();
  }
});

// ---------------------------------------------------------------- state

let lastRoot = null;
function renderAll() {
  renderSidebar();
  renderHeader();
  const w = activeWt();
  const ids = w ? sessFor(w).map(x => x.id) : [];
  if (S.active !== lastRoot) { lastRoot = S.active; E.setRoot(S.active); window.harborLayout.setRoot(S.active, ids); }
  else window.harborLayout.sync(S.active, ids);
  E.setLspStatus(S.lsp);
  window.harborLayout.renderTabs();
  window.harborStatus.sync();
}

async function refreshState() { S = await H.state(); renderAll(); }
H.onState(s => { S = s; window.harborTheme.sync(S.settings.theme); renderAll(); });

const E = window.harborEditor;

window.harborTheme.onChange(() => {
  for (const t of terms.values()) t.term.options.theme = window.harborTheme.xterm();
});

(async () => {
  S = await H.state();
  window.harborTheme.sync(S.settings.theme);
  setSidebarSide(S.ui.sidebarSide);
  window.harborLayout.init(S.ui);
  E.init(S);
  renderAll();
})();
