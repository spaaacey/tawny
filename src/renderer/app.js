'use strict';
/* global Terminal, FitAddon, WebglAddon */
const H = window.harbor;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = { repos: [], workspaces: [], sessions: [], active: null, editor: { state: 'stopped' }, settings: {}, ui: {} };
const terms = new Map();        // session id -> { term, fit, el, ready, pending }
const collapsed = new Set();

if (navigator.platform.toUpperCase().includes('MAC')) document.body.classList.add('mac');
if (H.dev) { document.body.classList.add('dev'); $('#devBanner').hidden = false; if (H.devPort) $('#devBanner').textContent = `DEV :${H.devPort}`; document.title = 'Tawny (dev)'; }

// ---------------------------------------------------------------- helpers

// sidebar order: plain workspaces first, then each repo's worktrees
const allWts = () => [
  ...(S.workspaces || []).map(w => ({ ...w, repoName: '' })),
  ...S.repos.flatMap(r => r.worktrees.map(w => ({ ...w, repoName: r.name }))),
];
const activeWt = () => allWts().find(w => w.path === S.active);
const sessFor = w => S.sessions.filter(s => s.prefix === w.prefix).sort((a, b) => a.index - b.index);
const label = w => w.name || w.branch || (w.detached ? `detached ${w.head.slice(0, 7)}` : w.path.split('/').pop());

const ICON = {
  chev: window.harborChevron,
  plus: '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  scratch: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5h7l2 2v9h-9zM10.5 2.5v2h2M5.5 7.5h5M5.5 10h3.5"/></svg>',
  folder: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>',
  branch: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-6.2 4.2"/></svg>',
  trash: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/></svg>',
};

// ---------------------------------------------------------------- sidebar

let renamingWs = false;   // an inline rename is open: don't rebuild the sidebar under it

function renderSidebar() {
  if (renamingWs) return;
  const root = $('#repos');
  if (!S.repos.length && !S.workspaces.length) {
    root.innerHTML = `<div class="center-msg" style="position:static;padding:40px 12px">
      <div class="empty-title">No workspaces</div>
      <button class="primary-btn" id="firstScratch">New scratch workspace</button>
      <button class="primary-btn" id="firstRepo">Add repository</button></div>`;
    $('#firstScratch').onclick = newScratch;
    $('#firstRepo').onclick = addRepo;
    return;
  }
  let n = 0;
  const row = w => {
    const all = sessFor(w), ss = all.filter(s => s.kind !== 'terminal'), working = ss.filter(s => s.working).length, waiting = ss.filter(s => s.waiting).length, k = ++n;
    const ind = waiting ? '<div class="dot wait"></div>' : working ? '<div class="spin"></div>' : ss.length ? '<div class="dot idle"></div>' : '<div class="dot none"></div>';
    const meta = [];
    if (w.main) meta.push('<span>main</span>');
    if (waiting) meta.push(`<span class="needs">${waiting === 1 && ss.length === 1 ? 'needs input' : `${waiting}/${ss.length} need input`}</span>`);
    else if (ss.length) meta.push(working ? `<span class="work">${working === 1 && ss.length === 1 ? 'working' : `${working}/${ss.length} working`}</span>` : `<span>${ss.length} agent${ss.length > 1 ? 's' : ''}</span>`);
    if (w.prunable || w.missing) meta.push('<span style="color:var(--danger)">missing</span>');
    const sessions = all.map(s => `<div class="st" data-path="${esc(w.path)}" data-id="${esc(s.id)}" title="${esc(s.kind === 'terminal' ? 'Terminal' : 'Agent')}">
      <div class="ind">${s.kind === 'terminal' ? '<span class="tglyph">&gt;_</span>' : s.waiting ? '<div class="dot wait"></div>' : s.working ? '<div class="spin"></div>' : '<div class="dot idle"></div>'}</div>
      <div class="br">${esc(window.harborLayout.agentLabel(s))}</div>
      <button class="icon-btn danger del" data-act="stop" title="${s.kind === 'terminal' ? 'Close terminal' : 'Stop agent'}">${ICON.trash}</button></div>`).join('');
    const del = w.plain ? `<button class="icon-btn danger del" data-act="rm" title="${w.scratch ? 'Remove scratch workspace' : 'Remove from Tawny (folder untouched)'}">${ICON.trash}</button>`
      : w.main ? '' : `<button class="icon-btn danger del" data-act="del" title="Delete worktree">${ICON.trash}</button>`;
    return `<div class="ws ${w.path === S.active ? 'active' : ''}"><div class="wt ${w.path === S.active ? 'active' : ''}" data-path="${esc(w.path)}" title="${esc(w.path)}">
      <div class="ind">${ind}</div>
      <div class="kind" title="${w.scratch ? 'Scratch workspace' : w.plain ? 'Folder workspace' : 'Git worktree'}">${w.scratch ? ICON.scratch : w.plain ? ICON.folder : ICON.branch}</div>
      <div class="lbl"><div class="br">${esc(label(w))}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
      <div class="right">${k <= 9 ? `<span class="key">⌥⌘${k}</span>` : ''}${del}</div>
    </div>${sessions}</div>`;
  };
  const plain = S.workspaces.length ? `<div class="repo plain"><div class="wts">${S.workspaces.map(w => row({ ...w, repoName: '' })).join('')}</div></div>` : '';
  root.innerHTML = plain + S.repos.map(r => `
    <div class="repo ${collapsed.has(r.path) ? 'collapsed' : ''}" data-repo="${esc(r.path)}">
      <div class="repo-head">
        <span class="toggle">${ICON.chev}</span>
        <span class="name toggle" title="${esc(r.path)}">${esc(r.name)}</span>
        <span class="acts">
          <button class="icon-btn" data-act="new" title="New worktree">${ICON.plus}</button>
          <button class="icon-btn danger" data-act="remove" title="Remove from Tawny (files untouched)">${ICON.x}</button>
        </span>
      </div>
      ${r.error ? `<div class="repo-err">${esc(r.error)}</div>` : ''}
      <div class="wts">${r.worktrees.map(w => row(w)).join('')}</div>
    </div>`).join('');

  root.querySelectorAll('.repo[data-repo]').forEach(el => {
    const repo = el.dataset.repo;
    el.querySelectorAll('.toggle').forEach(t => t.onclick = () => {
      collapsed.has(repo) ? collapsed.delete(repo) : collapsed.add(repo);
      el.classList.toggle('collapsed');
    });
    el.querySelector('[data-act=new]').onclick = e => { e.stopPropagation(); openNewWorktree(repo); };
    el.querySelector('[data-act=remove]').onclick = async e => {
      e.stopPropagation();
      if (confirm(`Remove ${repo.split('/').pop()} from Tawny?\n\nNothing on disk is deleted.`)) await H.removeRepo(repo);
    };
  });
  markSidebar();
  root.querySelectorAll('.st').forEach(el => {
    el.querySelector('[data-act=stop]').onclick = e => { e.stopPropagation(); stopAgent(el.dataset.id); };
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
    const rm = el.querySelector('[data-act=rm]');
    if (rm) {
      rm.onclick = e => { e.stopPropagation(); removeWorkspace(el.dataset.path); };
      el.ondblclick = e => { if (!e.target.closest('button')) renameWorkspace(el); };
      el.oncontextmenu = e => {
        e.preventDefault();
        E.showContextMenu(e.clientX, e.clientY, [{ label: 'Rename', run: () => renameWorkspace(el) }]);
      };
    }
  });
}

/** Rename a scratch/folder workspace inline; Enter saves, Esc cancels, empty resets to the folder name. */
function renameWorkspace(row) {
  const br = row.querySelector('.lbl .br'), p = row.dataset.path;
  if (!br || renamingWs) return;
  renamingWs = true;
  const input = document.createElement('input');
  input.className = 'ws-edit';
  input.value = br.textContent;
  br.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return;
    done = true;
    renamingWs = false;
    const v = input.value.trim();
    if (save && v !== br.textContent) { try { await H.renameWorkspace(p, v); } catch (e) { toast(e.message); } }
    renderSidebar();
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('dblclick', e => e.stopPropagation());
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

/** Highlight the sidebar row of the focused pane's tab. */
function markSidebar() {
  const k = window.harborLayout.activeKey();
  const id = k && k.startsWith('a:') ? k.slice(2) : null;
  document.querySelectorAll('#repos .st').forEach(el => el.classList.toggle('on', el.dataset.id === id));
}

// ---------------------------------------------------------------- header / editor

function renderHeader() {
  const env = [];
  if (!S.tmux) env.push(S.platform === 'win32' ? 'no tmux on Windows' : 'tmux not found — agents stop with Tawny');
  $('#envNote').textContent = env.join(' · ');
}

// ---------------------------------------------------------------- drag & drop

function setSidebarSide(side) {
  $('#app').classList.toggle('sidebar-right', side === 'right');
}
const sidebarSide = () => ($('#app').classList.contains('sidebar-right') ? 'right' : 'left');
window.harborDnd.dock($('.side-label'), $('#app'), {
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
    minimumContrastRatio: 4.5,   // TUIs that paint their own selection bg (Claude Code) otherwise leave light text on light blue
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
  window.harborChat.dispose(id);
});

function fitTerm(t) {
  if (!t || t.el.hidden || !t.el.offsetWidth) return;
  try { t.fit.fit(); } catch { /* not ready */ }
}
function fitAll() { for (const t of terms.values()) fitTerm(t); }

function focusAgent() {
  const id = window.harborLayout.currentAgent();
  if (id) { window.harborLayout.revealAgent(id); focusTerm(id); }
  else document.querySelector('.glaunch:not([hidden]) .lq')?.focus();
}
const isChat = id => S.sessions.some(x => x.id === id && x.kind === 'chat');
function focusTerm(id) {
  if (isChat(id)) return window.harborChat.focus(id);
  requestAnimationFrame(() => terms.get(id)?.term.focus());
}

/** Start an agent (or a plain terminal) as a tab in group `gid` (default: the focused group). */
async function newAgent(gid, kind = 'agent', opts) {
  const w = activeWt();
  if (!w) return;
  const Lay = window.harborLayout;
  Lay.expectAgent(typeof gid === 'string' ? gid : Lay.focusedGroup());
  let id;
  try { id = await H.createAgent(w.path, kind, opts); }
  catch (e) { toast(`Agent failed to start: ${e.message}`, 8000); await refreshState(); Lay.expectAgent(null); return; }
  await refreshState();
  Lay.expectAgent(null);
  Lay.revealAgent(id);
  focusTerm(id);
}

/** Sign in to a chat's agent: opens a terminal tab with its login command, or lets the agent authenticate itself. */
async function chatAuth(id, methodId) {
  const Lay = window.harborLayout;
  Lay.expectAgent(Lay.focusedGroup());
  let nid;
  try { nid = await H.chatAuth(id, methodId); }
  finally { await refreshState(); Lay.expectAgent(null); }
  if (nid) { Lay.revealAgent(nid); focusTerm(nid); }
}

/** Close a chat tab and continue its conversation in a terminal agent tab (same pane). */
async function chatToTerminal(id) {
  const Lay = window.harborLayout;
  Lay.expectAgent(Lay.focusedGroup());
  let nid;
  try { nid = await H.chatToTerminal(id); }
  finally { await refreshState(); Lay.expectAgent(null); }
  Lay.revealAgent(nid);
  focusTerm(nid);
}

/** Split the focused pane downward and start a terminal in the new pane. */
function newSplitTerminal() {
  const g = window.harborLayout.splitFocused('bottom');
  return g && newAgent(g.id, 'terminal');
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
async function newScratch() {
  try { await H.addScratch(); } catch (e) { toast(e.message); }
}
async function addFolder() {
  try { await H.addFolder(); } catch (e) { toast(e.message); }
}
async function removeWorkspace(p) {
  const w = allWts().find(x => x.path === p);
  if (!w) return;
  const ss = sessFor(w);
  const what = w.scratch ? 'Its folder is deleted if empty.' : 'The folder is untouched.';
  if (!confirm(`Remove workspace "${label(w)}"?\n\n${ss.length ? `${ss.length} agent/terminal tab(s) will be stopped. ` : ''}${what}`)) return;
  try { await H.removeWorkspace(p); E.forgetRoot(p); } catch (e) { alert(e.message); }
}
$('#addRepo').onclick = () => H.addMenu();
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
  if (isChat(id)) { window.harborChat.insert(id, text); window.harborLayout.revealAgent(id); focusTerm(id); return; }
  H.writeAgent(id, text);
  window.harborLayout.revealAgent(id);
  focusTerm(id);
}

/** Message box for the agent: `ref` (e.g. "@file#L3-5") is prefixed; shift+tab cycles the target agent (current one first). */
let sendRef = '', sendPrev = null, sendAgents = [], sendIdx = 0;
function renderSendAgent() {
  const a = sendAgents[sendIdx];
  $('#sendAgent').hidden = sendAgents.length < 2;
  if (!a) return;
  $('#sendAgentName').textContent = window.harborLayout.agentLabel(a);
  $('#sendAgent .sdot').className = 'sdot' + (a.waiting ? ' wait' : a.working ? ' work' : '');
}
function composeToAgent(ref) {
  const w = activeWt();
  if (!w) return;
  sendAgents = sessFor(w).filter(s => (s.kind === 'agent' || s.kind === 'chat'));
  sendIdx = Math.max(0, sendAgents.findIndex(a => a.id === window.harborLayout.currentAgent()));
  sendRef = ref;
  sendPrev = document.activeElement;
  $('#sendRef').textContent = ref;
  renderSendAgent();
  $('#sendInput').value = '';
  showOverlay($('#sendBack'));
  $('#sendInput').focus();
}
function closeSend(restore = true) {
  hideOverlay($('#sendBack'));
  if (restore && sendPrev && sendPrev.isConnected) sendPrev.focus();
  sendPrev = null;
}
async function submitSend() {
  const msg = $('#sendInput').value.trim();
  const id = sendAgents[sendIdx]?.id;
  closeSend(false);
  await askAgent(sendRef, msg, id);
}
/** Send `ref` + `msg` to agent `id` (or the current one) and press enter; with no message just drop the reference into the prompt. */
async function askAgent(ref, msg, id) {
  const target = id || window.harborLayout.currentAgent();
  if (target && isChat(target)) {
    window.harborLayout.revealAgent(target);
    window.harborChat.ask(target, ref, msg);
    return focusTerm(target);
  }
  if (!msg) return sendToAgent(ref + ' ', id);
  await sendToAgent(`${ref} ${msg}`, id);
  const t = id || window.harborLayout.currentAgent();
  setTimeout(() => H.writeAgent(t, '\r'), 80);       // separate write so it's Enter, not part of a paste
}
/** The current worktree's agents and the index of the one that is current, for the selection message box. */
function sendTargets() {
  const w = activeWt();
  const agents = w ? sessFor(w).filter(s => (s.kind === 'agent' || s.kind === 'chat')).map(a => ({ id: a.id, label: window.harborLayout.agentLabel(a), working: a.working, waiting: a.waiting })) : [];
  return { agents, index: Math.max(0, agents.findIndex(a => a.id === window.harborLayout.currentAgent())) };
}
$('#sendInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); submitSend(); }
  else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); if (sendAgents.length > 1) { sendIdx = (sendIdx + 1) % sendAgents.length; renderSendAgent(); } }
  else if (e.key === 'Escape') closeSend();
});
$('#sendGo').addEventListener('click', submitSend);
$('#sendCancel').addEventListener('click', () => closeSend());
$('#sendBack').addEventListener('mousedown', e => { if (e.target.id === 'sendBack') closeSend(); });

window.harborApp = {
  openPalette: initial => openPalette(initial),
  settings: () => S.settings, showOverlay, hideOverlay, toast, sendToAgent, composeToAgent, askAgent, sendTargets, newAgent, chatAuth, chatToTerminal, stopAgent, fitAll, focusTerm,
  termEl: id => (isChat(id) ? window.harborChat.el(id) : getTerm(id).el),
  renameAgent: (id, title) => H.renameAgent(id, title),
  markSidebar,
  state: () => S,
  revealSession: async (p, id) => { await activate(p); window.harborLayout.revealAgent(id); focusTerm(id); },
  activePath: () => (activeWt() || {}).path || null,
  agentInfo: id => S.sessions.find(x => x.id === id) || null,
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
  ['File', 'New Tab', '⌘N', () => Lay().newTab()],
  ['File', 'New Tab in Split Pane', '⌘T', () => Lay().splitFocused('right')],
  ['File', 'New Terminal in Pane Below', '⌘J', () => newSplitTerminal()],
  ['File', 'New Terminal', '', () => newAgent(undefined, 'terminal')],
  ['File', 'New Markdown File…', '', () => Lay().newMarkdown()],
  ['File', 'Go to File…', '⌘P', () => E.openQuickOpen()],
  ['File', 'Save', '⌘S', () => E.save()],
  ['File', 'Close Tab', '⌘W', () => Lay().closeActive()],
  ['File', 'New Scratch Workspace', '', () => newScratch()],
  ['File', 'Open Folder as Workspace…', '', () => addFolder()],
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
  ['Go', 'Focus Pane…', '⌘⇧J', () => Lay().pickPane()],
  ['Go', 'Previous Tab', '⌥⌘←', () => Lay().cycleTab(-1)],
  ['Go', 'Next Tab', '⌥⌘→', () => Lay().cycleTab(1)],
  ['Agent', 'New Agent', '⌥⌘T', () => newAgent()],
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
  ['View', 'Find in Files', '⌥⌘F', () => openFindPalette()],
  ['View', 'Show Find in Secondary Sidebar', '', () => E.showFind()],
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
let pItems = [], pSel = 0, pPrev = null;
// The palette has three modes (tabs, left/right at the input's edge switches): files, commands ('>' typed first), text search ('#').
const MODES = ['file', 'cmd', 'text'];
let pMode = 'file';
function openPalette(initial = '>') {
  pPrev = document.activeElement;
  showOverlay($('#paletteBack'));
  pMode = initial[0] === '>' ? 'cmd' : initial[0] === '#' ? 'text' : 'file';
  $('#paletteInput').value = pMode === 'file' ? initial : initial.slice(1);
  pSel = 0;
  hashKey = null; hashShown = false;
  renderPalette();
  $('#paletteInput').focus();
}
function closePalette(restore = true) {
  hideOverlay($('#paletteBack'));
  if (restore && pPrev && pPrev.isConnected) pPrev.focus();
  pPrev = null;
}
// '#' mode: text search across the workspace (src/main/search.js), one row per matching line. Options, replace text and
// replace logic are the Find sidebar's (find.js); the palette's own controls just mirror them.
const HASH_LIMIT = 200;
const F = () => window.harborFind;
const REPLACE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 5.5h8.5M8.5 3l2.5 2.5L8.5 8M13.5 10.5H5M7.5 8 5 10.5 7.5 13"/></svg>';
let hashTimer, hashSeq = 0, hashKey = null, hashQ = '', hashMatches = [], hashMsg = '', hashShown = false;
const inHash = () => !$('#paletteBack').hidden && pMode === 'text';
function searchHash(q, o) {
  clearTimeout(hashTimer);
  const root = E.root, id = 1e9 + ++hashSeq;   // ids far from the Find sidebar's: they cancel each other's searches
  hashMatches = [];
  if (!q || !root) { hashMsg = q ? 'No folder open' : 'Type to search in files'; return; }
  hashMsg = 'Searching…';
  hashTimer = setTimeout(async () => {
    let msg = '', found = [];
    try {
      const r = await H.search(root, { query: q, matchCase: o.matchCase, wholeWord: o.wholeWord, regex: o.regex, include: o.include, exclude: o.exclude, limit: HASH_LIMIT }, id);
      if (r.cancelled) return;
      found = r.files.flatMap(f => f.matches.map(m => ({ rel: f.path, m })));
      msg = 'No matches';
    } catch (e) {
      msg = String(e.message).replace(/^\/.*\/[a-z]*: /, '');
    }
    if (id !== 1e9 + hashSeq || !inHash()) return;
    hashMatches = found; hashMsg = msg;
    renderPalette();
  }, 200);
}
function hashRows(o) {
  const root = E.root;
  return hashMatches.filter(({ m }, i, a) => o.replacing || !i || m.l !== a[i - 1].m.l || a[i - 1].rel !== a[i].rel).map(({ rel, m }) => {   // one row per line (per match when replacing)
    const n = Math.min(m.n, m.t.length - m.o), hit = m.t.slice(m.o, m.o + n);
    const mid = !o.replacing ? `<b>${esc(hit)}</b>`
      : o.replace !== '' ? `<del>${esc(hit)}</del><ins>${esc(F().replacement(hit))}</ins>` : `<del>${esc(hit)}</del>`;
    return {
      rel, m,
      title: `${rel}:${m.l}`,
      html: `<span class="qm">${esc(m.t.slice(0, m.o))}${mid}${esc(m.t.slice(m.o + n))}</span><span class="r">${esc(rel)}:${m.l}</span>${o.replacing ? `<span class="po-act" title="Replace (cmd+enter)">${REPLACE_ICON}</span>` : ''}`,
      run: () => E.openFile(`${root}/${rel}`, { selection: { startLineNumber: m.l, startColumn: m.c + 1, endLineNumber: m.l, endColumn: m.c + 1 + m.n } }),
    };
  });
}
/** Mirror the sidebar's options into the palette's controls (when entering '#' mode). */
function fillHashOpts() {
  const o = F().getOpts();
  $('#poReplace').value = o.replace; $('#poInc').value = o.include; $('#poExc').value = o.exclude;
  $('#poDetails').hidden = !(o.include || o.exclude);
}
function paintHashOpts(o) {
  document.querySelectorAll('#paletteOpts [data-po]').forEach(b => b.classList.toggle('on', o[b.dataset.po]));
  $('#poRepToggle').classList.toggle('open', o.replacing);
  $('#poRepField').hidden = !o.replacing;
}
async function replaceSelected() {
  const it = pItems[pSel];
  if (!it || !it.rel || !F().getOpts().replacing) return;
  try { await F().replaceMatch(it.rel, it.m, hashQ); } catch (e) { return toast(`Replace failed: ${e.message}`); }
  hashKey = null; renderPalette();   // search again: the rows after this one have moved up
}
async function replaceAllHash() {
  if (!hashQ || !F().getOpts().replacing) return;
  const note = await F().replaceAll(hashQ);
  if (note) toast(note);
  hashKey = null; renderPalette();
}
/** cmd+option+f: the palette in '#' mode, seeded with the editor's (single-line) selection. */
function openFindPalette() {
  const sel = E.selectedText();
  openPalette('#' + (sel && !/[\r\n]/.test(sel) ? sel : ''));
  $('#paletteInput').select();   // typing replaces the seed
}
/** cmd+option+f inside '#' mode: carry the query and options over to the Find sidebar. */
function paletteToSidebar() {
  const q = $('#paletteInput').value;
  closePalette(false);
  E.showFind();
  F().setOpts({ query: q });
  F().run();
}
function renderPalette() {
  const raw = $('#paletteInput').value;
  const cmdMode = pMode === 'cmd', hashMode = pMode === 'text';
  hashShown = hashShown && hashMode;
  document.querySelectorAll('#paletteTabs [data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === pMode));
  $('#paletteOpts').hidden = !hashMode;
  $('#paletteInput').placeholder = cmdMode ? 'Type a command…' : hashMode ? 'Search in files…' : 'Go to file…   (name:line works too)';
  let rows;
  if (hashMode) {
    if (!hashShown) fillHashOpts();
    hashShown = true;
    const o = F().getOpts(), q = raw;
    paintHashOpts(o);
    const key = JSON.stringify([q, o.matchCase, o.wholeWord, o.regex, o.include, o.exclude]);
    if (key !== hashKey) { hashKey = key; hashQ = q; F().setOpts({ query: q }); searchHash(q, o); }   // arrow keys and replace text only re-render
    pItems = hashRows(o);
    rows = hashMsg;
  } else if (cmdMode) {
    const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
    const num = /^\d+$/.test(raw.trim()) ? +raw : 0;   // ">2" jumps to page 2
    const pages = Lay().pages().map(({ i, label }) => ({ cat: 'Page', title: label, keys: '', run: () => Lay().setPage(i), n: i + 1 }));
    pItems = [...COMMANDS, ...pages]
      .map(c => {
        if (num && c.n === num) return { c, score: -1 };
        if (num) return null;
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
    E.loadFileIndex().then(() => { if (!$('#paletteBack').hidden && pMode === 'file') renderPalette(); });
  } else {
    pItems = E.fileMatches(raw).map(r => ({ run: () => E.openFileResult(r), title: r.f, html: E.fileRowHtml(r) }));
    rows = 'No matching files';
  }
  pSel = Math.min(pSel, Math.max(0, pItems.length - 1));
  $('#paletteList').innerHTML = pItems.map((c, i) =>
    `<div class="qi ${i === pSel ? 'sel' : ''}" data-i="${i}">${c.html}</div>`
  ).join('') || `<div class="qi muted">${rows}</div>`;
  $('#paletteList').querySelector('.qi.sel')?.scrollIntoView({ block: 'nearest' });
  $('#paletteList').querySelectorAll('.qi[data-i]').forEach(el => el.onmousedown = e => { e.preventDefault(); if (e.target.closest('.po-act')) { pSel = +el.dataset.i; replaceSelected(); } else runPalette(+el.dataset.i); });
}
function runPalette(i) {
  const c = pItems[i];
  closePalette();
  if (c) Promise.resolve().then(c.run).catch(e => toast(`${c.title}: ${e.message}`));
}
function setPaletteMode(m) {
  pMode = m; pSel = 0; hashKey = null;
  renderPalette();
  $('#paletteInput').focus();
}
$('#paletteInput').addEventListener('input', () => {
  const inp = $('#paletteInput'), c = inp.value[0];
  if (pMode === 'file' && (c === '>' || c === '#')) { inp.value = inp.value.slice(1); pMode = c === '>' ? 'cmd' : 'text'; }   // typing the old prefix still switches
  pSel = 0; renderPalette();
});
document.querySelectorAll('#paletteTabs [data-mode]').forEach(b => b.addEventListener('mousedown', e => { e.preventDefault(); setPaletteMode(b.dataset.mode); }));
const hashKeys = { KeyC: 'matchCase', KeyW: 'wholeWord', KeyR: 'regex' };
function paletteKeys(e) {
  if (e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); e.target.select(); return; }   // no Select All menu role (see commitMsg in editor.js)
  const hash = inHash();
  const inp = e.target.id === 'paletteInput' && e.target;
  const edge = inp && !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey && inp.selectionStart === inp.selectionEnd
    && (e.key === 'ArrowLeft' ? inp.selectionStart === 0 : e.key === 'ArrowRight' && inp.selectionStart === inp.value.length);
  if (edge) {
    const to = MODES[MODES.indexOf(pMode) + (e.key === 'ArrowLeft' ? -1 : 1)];
    if (to) setPaletteMode(to);
    e.preventDefault();
  }
  else if (hash && e.metaKey && e.altKey && hashKeys[e.code]) { toggleHashOpt(hashKeys[e.code]); e.preventDefault(); }
  else if (hash && e.metaKey && e.shiftKey && e.code === 'KeyJ') { $('#poDetails').hidden = !$('#poDetails').hidden; e.preventDefault(); }
  else if (hash && e.metaKey && e.shiftKey && e.code === 'KeyH') { toggleHashReplace(); e.preventDefault(); }
  else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { pSel = Math.min(pItems.length - 1, pSel + 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { pSel = Math.max(0, pSel - 1); renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') {
    if (hash && e.metaKey) replaceSelected();
    else if (e.target.id === 'poReplace') replaceAllHash();
    else if (e.target.id === 'paletteInput') runPalette(pSel);
  }
  else if (e.key === 'Backspace' && inp && pMode !== 'file' && !inp.value) setPaletteMode('file');
  else if (e.key === 'Escape') closePalette();
}
$('#paletteInput').addEventListener('keydown', paletteKeys);
function toggleHashOpt(name) {
  F().setOpts({ [name]: !F().getOpts()[name] });
  renderPalette();
}
function toggleHashReplace() {
  const on = !F().getOpts().replacing;
  F().setOpts({ replacing: on });
  renderPalette();
  $(on ? '#poReplace' : '#paletteInput').focus();
}
document.querySelectorAll('#paletteOpts [data-po]').forEach(b => b.addEventListener('click', () => { toggleHashOpt(b.dataset.po); $('#paletteInput').focus(); }));
$('#poRepToggle').innerHTML = window.harborChevron;
$('#poRepToggle').addEventListener('click', toggleHashReplace);
$('#poDetailsBtn').addEventListener('click', () => { $('#poDetails').hidden = !$('#poDetails').hidden; $('#paletteInput').focus(); });
for (const [id, key] of [['#poReplace', 'replace'], ['#poInc', 'include'], ['#poExc', 'exclude']]) {
  $(id).addEventListener('keydown', paletteKeys);
  $(id).addEventListener('input', e => { F().setOpts({ [key]: e.target.value }); if (key !== 'replace') pSel = 0; renderPalette(); });
}
$('#paletteBack').addEventListener('mousedown', e => { if (e.target.id === 'paletteBack') closePalette(); });

H.onMenu((cmd, arg) => {
  const list = allWts();
  switch (cmd) {
    case 'addRepo': return addRepo();
    case 'newScratch': return newScratch();
    case 'addFolder': return addFolder();
    case 'newWorktree': return openNewWorktree();
    case 'palette': return openPalette();
    case 'quickSwitch': return openQuick();
    case 'cycle': return cycleWt(arg);
    case 'jump': if (list[arg]) activate(list[arg].path); return;
    case 'focusAgent': return focusAgent();
    case 'newAgent': return newAgent();
    case 'newTab': return window.harborLayout.newTab();
    case 'newSplitTerminal': return newSplitTerminal();
    case 'newSplitTab': return window.harborLayout.splitFocused(arg || 'right');
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
    case 'findInFiles': return inHash() ? paletteToSidebar() : openFindPalette();
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
H.onState(s => { S = s; window.harborTheme.sync(S.settings.theme); renderAll(); window.harborChat.refresh(); });

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
