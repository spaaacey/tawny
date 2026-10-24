'use strict';
/* global Terminal, FitAddon, WebglAddon */
const H = window.harbor;
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = { repos: [], sessions: [], active: null, editor: { state: 'stopped' }, settings: {}, ui: {} };
const terms = new Map();        // session id -> { term, fit, el, ready, pending }
const activeTab = new Map();    // worktree prefix -> session id
const collapsed = new Set();
const fileView = new Set();     // worktree paths currently showing a file tab instead of an agent

if (navigator.platform.toUpperCase().includes('MAC')) document.body.classList.add('mac');

// ---------------------------------------------------------------- helpers

const allWts = () => S.repos.flatMap(r => r.worktrees.map(w => ({ ...w, repoName: r.name })));
const activeWt = () => allWts().find(w => w.path === S.active);
const agentOrder = {};          // worktree prefix -> session ids in user-chosen tab order
const rank = (s, order) => { const i = (order || []).indexOf(s.id); return i < 0 ? Infinity : i; };
const sessFor = w => S.sessions.filter(s => s.prefix === w.prefix)
  .sort((a, b) => (rank(a, agentOrder[w.prefix]) - rank(b, agentOrder[w.prefix])) || a.index - b.index);
const label = w => w.branch || (w.detached ? `detached ${w.head.slice(0, 7)}` : w.path.split('/').pop());

const ICON = {
  chev: '<svg class="chev" viewBox="0 0 16 16" width="12" height="12"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
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
        const ss = sessFor(w), working = ss.filter(s => s.working).length, k = ++n;
        const ind = working ? '<div class="spin"></div>' : ss.length ? '<div class="dot idle"></div>' : '<div class="dot none"></div>';
        const meta = [];
        if (w.main) meta.push('<span>main</span>');
        if (ss.length) meta.push(working ? `<span class="work">${working === 1 && ss.length === 1 ? 'working' : `${working}/${ss.length} working`}</span>` : `<span>${ss.length} agent${ss.length > 1 ? 's' : ''}</span>`);
        if (w.dirty > 0) meta.push(`<span class="dirty">±${w.dirty}</span>`);
        if (w.prunable) meta.push('<span style="color:var(--danger)">missing</span>');
        return `<div class="wt ${w.path === S.active ? 'active' : ''}" data-path="${esc(w.path)}" title="${esc(w.path)}">
          <div class="ind">${ind}</div>
          <div class="lbl"><div class="br">${esc(label(w))}</div>${meta.length ? `<div class="meta">${meta.join('')}</div>` : ''}</div>
          <div class="right">${k <= 9 ? `<span class="key">⌥⌘${k}</span>` : ''}
            ${w.main ? '' : `<button class="icon-btn danger del" data-act="del" title="Delete worktree">${ICON.trash}</button>`}</div>
        </div>`;
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
  root.querySelectorAll('.wt').forEach(el => {
    el.onclick = () => activate(el.dataset.path);
    const del = el.querySelector('[data-act=del]');
    if (del) del.onclick = e => { e.stopPropagation(); deleteWorktree(el.dataset.path); };
  });
}

// ---------------------------------------------------------------- header / editor

function renderHeader() {
  const env = [];
  if (!S.tmux) env.push(S.platform === 'win32' ? 'no tmux on Windows' : 'tmux not found — agents stop with Harbor');
  $('#envNote').textContent = env.join(' · ');
}

new ResizeObserver(() => fitActive()).observe($('#terms'));
window.addEventListener('resize', () => fitActive());

const inFileView = () => fileView.has(S.active);

/** Show either the agent terminal or the editor in the content area; tabs of both kinds live in one bar. */
function applyView() {
  const file = inFileView();
  const app = $('#app');
  app.classList.toggle('view-file', file);
  app.classList.toggle('view-agent', !file);
  renderAgents();
  E.renderTabs();
  requestAnimationFrame(() => fitActive());
}

function showAgentView() {
  if (fileView.delete(S.active)) applyView();
}
function showFileView() {
  fileView.add(S.active);
  applyView();
}

// ---------------------------------------------------------------- drag & drop

function setSidebarSide(side) {
  $('#app').classList.toggle('sidebar-right', side === 'right');
  requestAnimationFrame(fitActive);
}
const sidebarSide = () => ($('#app').classList.contains('sidebar-right') ? 'right' : 'left');
window.harborDnd.dock($('.side-head .brand'), $('#app'), {
  getSide: sidebarSide,
  setSide: side => { setSidebarSide(side); H.saveUi({ sidebarSide: side }); },
});

window.harborDnd.reorder($('#agentTabs'), '.atab', el => el.dataset.id, (id, to) => {
  const w = activeWt();
  if (!w) return;
  const ids = sessFor(w).map(s => s.id).filter(x => x !== id);
  ids.splice(to, 0, id);
  agentOrder[w.prefix] = ids;
  H.saveUi({ agentOrder });
  renderAgents();
}, '.x');

// ---------------------------------------------------------------- agents

const THEME = {
  background: '#0f1115', foreground: '#d7dae0', cursor: '#6ea8fe', cursorAccent: '#0f1115',
  selectionBackground: 'rgba(110,168,254,0.28)',
  black: '#1b1e24', red: '#f2706b', green: '#5fcf8b', yellow: '#e5b454', blue: '#6ea8fe', magenta: '#c49bf5', cyan: '#5ec4d4', white: '#d7dae0',
  brightBlack: '#545b66', brightRed: '#ff8c87', brightGreen: '#7ee0a5', brightYellow: '#f2c86e', brightBlue: '#8dbbff', brightMagenta: '#d5b3ff', brightCyan: '#7fd6e3', brightWhite: '#ffffff',
};

function getTerm(id) {
  let t = terms.get(id);
  if (t) return t;
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;
  $('#terms').appendChild(el);
  const term = new Terminal({
    fontFamily: '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace', fontSize: 13,
    theme: THEME, cursorBlink: true, scrollback: 10000,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch { /* falls back to the DOM renderer */ }
  term.onData(d => H.writeAgent(id, d));
  term.onResize(({ cols, rows }) => H.resizeAgent(id, cols, rows));
  // ⌘K clears, ⌘←/→ line nav like a normal mac terminal
  // xterm.js: returning false means "handled, skip default"
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown') return true;
    if (e.metaKey && e.key === 'k') { term.clear(); return false; }
    if (e.metaKey && e.key === 'ArrowLeft') { H.writeAgent(id, '\x01'); return false; }
    if (e.metaKey && e.key === 'ArrowRight') { H.writeAgent(id, '\x05'); return false; }
    if (e.metaKey && e.key === 'Backspace') { H.writeAgent(id, '\x15'); return false; }
    return true;
  });
  t = { term, fit, el, ready: false, pending: [] };
  terms.set(id, t);
  H.agentBuffer(id).then(buf => {
    if (buf) term.write(buf);
    for (const d of t.pending) term.write(d);
    t.pending = [];
    t.ready = true;
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

function currentSessionId() {
  const w = activeWt();
  if (!w) return null;
  const ss = sessFor(w);
  if (!ss.length) return null;
  const want = activeTab.get(w.prefix);
  return ss.find(s => s.id === want) ? want : ss[0].id;
}

function renderAgents() {
  const w = activeWt();
  const ss = w ? sessFor(w) : [];
  const cur = currentSessionId();
  const file = inFileView();
  $('#agentTabs').innerHTML = ss.map(s => `
    <div class="atab ${s.id === cur && !file ? 'on' : ''}" data-id="${esc(s.id)}">
      ${s.working ? '<div class="spin" style="width:9px;height:9px;border-width:1.6px"></div>' : '<div class="dot idle" style="width:6px;height:6px;box-shadow:none"></div>'}
      agent ${s.index}
      <span class="x" title="Stop agent">${ICON.x}</span>
    </div>`).join('');
  $('#agentTabs').querySelectorAll('.atab').forEach(el => {
    el.onclick = () => { activeTab.set(w.prefix, el.dataset.id); fileView.delete(S.active); applyView(); focusAgent(); };
    el.querySelector('.x').onclick = async e => {
      e.stopPropagation();
      if (confirm('Stop this agent? Its tmux session is killed.')) await H.killAgent(el.dataset.id);
    };
  });
  $('#agentEmpty').hidden = !!ss.length || !w || file;
  $('#agentErr').hidden = !S.agentError;
  $('#agentErr').textContent = S.agentError || '';
  $('#agentCmdHint').textContent = S.settings.agentCommand ? `$ ${S.settings.agentCommand}` : '';
  // ensure terminals exist for all sessions of this worktree; show only the current one
  for (const s of ss) getTerm(s.id);
  for (const [id, t] of terms) {
    const show = id === cur && !file;
    if (t.el.hidden === show) { t.el.hidden = !show; if (show) requestAnimationFrame(() => fitActive()); }
  }
}

function fitActive() {
  const id = currentSessionId();
  const t = id && terms.get(id);
  if (!t || t.el.hidden || !t.el.offsetWidth) return;
  try { t.fit.fit(); } catch { /* not ready */ }
}

function focusAgent() {
  const id = currentSessionId();
  showAgentView();
  if (id) requestAnimationFrame(() => terms.get(id)?.term.focus());
  else $('#startAgentBtn')?.focus();
}

async function newAgent() {
  const w = activeWt();
  if (!w) return;
  let id;
  try { id = await H.createAgent(w.path); }
  catch (e) { toast(`Agent failed to start: ${e.message}`, 8000); await refreshState(); return; }
  activeTab.set(w.prefix, id);
  fileView.delete(w.path);
  await refreshState();
  applyView();
  focusAgent();
}
$('#newAgentBtn').onclick = newAgent;
$('#startAgentBtn').onclick = newAgent;

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

/** Type text into the current worktree's agent (starting one if needed). */
async function sendToAgent(text) {
  const w = activeWt();
  if (!w) return;
  let id = currentSessionId();
  if (!id) { await newAgent(); await new Promise(r => setTimeout(r, 2500)); id = currentSessionId(); }
  if (!id) return;
  H.writeAgent(id, text);
  focusAgent();
}

window.harborApp = { showOverlay, hideOverlay, toast, sendToAgent, inFileView, showFileView, showAgentView, applyView };
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
    if (startAgent) setTimeout(focusAgent, 100);
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
    const ss = sessFor(w), working = ss.some(s => s.working);
    return `<div class="qi ${i === qSel ? 'sel' : ''}" data-i="${i}">
      ${working ? '<div class="spin"></div>' : ss.length ? '<div class="dot idle"></div>' : '<div class="dot none"></div>'}
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

H.onMenu((cmd, arg) => {
  const list = allWts();
  const i = list.findIndex(w => w.path === S.active);
  switch (cmd) {
    case 'addRepo': return addRepo();
    case 'newWorktree': return openNewWorktree();
    case 'quickSwitch': return openQuick();
    case 'cycle': if (list.length) activate(list[(i + arg + list.length) % list.length].path); return;
    case 'jump': if (list[arg]) activate(list[arg].path); return;
    case 'focusAgent': return focusAgent();
    case 'newAgent': return newAgent();
    case 'toggleSidebar': $('#app').classList.toggle('no-sidebar'); requestAnimationFrame(fitActive); return;
    case 'goToFile': return E.openQuickOpen();
    case 'save': return inFileView() && E.save();
    case 'closeTab': return inFileView() && E.closeTab();
    case 'focusEditor': showFileView(); return E.focus();
    case 'toggleTree': { const was = inFileView(); showFileView(); return E.toggleTree(!was); }
  }
});

// ---------------------------------------------------------------- state

let lastRoot = null;
function renderAll() {
  renderSidebar();
  renderHeader();
  if (S.active !== lastRoot) { lastRoot = S.active; E.setRoot(S.active); }
  E.setLspStatus(S.lsp);
  applyView();
}

async function refreshState() { S = await H.state(); renderAll(); }
H.onState(s => { S = s; renderAll(); });

const E = window.harborEditor;

(async () => {
  S = await H.state();
  Object.assign(agentOrder, S.ui.agentOrder);
  setSidebarSide(S.ui.sidebarSide);
  E.init(S);
  renderAll();
})();
