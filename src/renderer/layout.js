'use strict';
// Split-pane workspace: per worktree, a tree of tab groups. A tab is an agent ('a:<session id>'), a file ('f:<path>')
// or a diff ('d:s:<path>' staged: HEAD↔index, 'd:w:<path>' unstaged: index↔working tree).
// Tabs can be dragged between groups, reordered, or dropped on a group's edge to split it.
(() => {
  const H = window.harbor;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const E = () => window.harborEditor;
  const APP = () => window.harborApp;
  const MIN_PX = 140;
  const EDGE = 0.25;               // outer fraction of a group that splits it when dropped on
  const X = '<svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const PLUS = '<svg viewBox="0 0 16 16" width="13" height="13"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';

  const layouts = new Map();       // root -> { tree, focus, lastFile, lastAgent }
  const groupEls = new Map();      // group id -> { el, tabs, body, host, binary, empty, tok, mounted, pending, html, shown }
  let root = null, seq = 0, legacy = {}, expectGroup = null, structSig = '', dragKey = null;

  // ------------------------------------------------------------------ tree

  const nid = () => `g${++seq}`;
  const leaf = (tabs = [], active = null) => ({ id: nid(), tabs, active });
  const isLeaf = n => !n.children;
  function* leaves(n) { if (isLeaf(n)) yield n; else for (const c of n.children) yield* leaves(c); }
  const firstLeaf = lay => leaves(lay.tree).next().value;
  const leafById = (lay, id) => { for (const g of leaves(lay.tree)) if (g.id === id) return g; return null; };
  const groupOf = (lay, key) => { for (const g of leaves(lay.tree)) if (g.tabs.includes(key)) return g; return null; };
  function parentOf(tree, node) {
    if (isLeaf(tree)) return null;
    for (let i = 0; i < tree.children.length; i++) {
      const c = tree.children[i];
      if (c === node) return { parent: tree, index: i };
      const r = parentOf(c, node);
      if (r) return r;
    }
    return null;
  }
  const renorm = a => { const t = a.reduce((x, y) => x + y, 0) || 1; return a.map(v => v / t); };

  /** Drop empty groups, merge splits of the same direction, unwrap single-child splits. */
  function prune(n) {
    if (isLeaf(n)) return n.tabs.length ? n : null;
    const kids = [], sizes = [];
    n.children.forEach((c, i) => { const p = prune(c); if (p) { kids.push(p); sizes.push(n.sizes[i]); } });
    if (!kids.length) return null;
    n.children = kids; n.sizes = renorm(sizes);
    return n;
  }
  function normalize(n) {
    if (isLeaf(n)) return n;
    n.children = n.children.map(normalize);
    const kids = [], sizes = [];
    n.children.forEach((c, i) => {
      if (!isLeaf(c) && c.dir === n.dir) c.children.forEach((cc, j) => { kids.push(cc); sizes.push(n.sizes[i] * c.sizes[j]); });
      else { kids.push(c); sizes.push(n.sizes[i]); }
    });
    n.children = kids; n.sizes = renorm(sizes);
    return kids.length === 1 ? kids[0] : n;
  }
  function clean(lay) {
    if (!isLeaf(lay.tree) || lay.tree.tabs.length) {
      lay.tree = normalize(prune(lay.tree) || leaf());
    }
    if (!leafById(lay, lay.focus)) lay.focus = firstLeaf(lay).id;
    for (const g of leaves(lay.tree)) if (!g.tabs.includes(g.active)) g.active = g.tabs[0] ?? null;
  }

  function detach(g, key) {
    const i = g.tabs.indexOf(key);
    if (i < 0) return;
    g.tabs.splice(i, 1);
    if (g.active === key) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] ?? null;
  }
  function attach(g, key, index) {
    if (index == null || index > g.tabs.length) index = g.tabs.length;
    g.tabs.splice(index, 0, key);
    g.active = key;
  }
  function addAgentTab(g, key) {
    g.tabs.push(key);
    if (!g.active) g.active = key;
  }
  function splitGroup(lay, target, side, key) {
    const ng = leaf([key], key);
    const node = { dir: side === 'left' || side === 'right' ? 'row' : 'col', sizes: [0.5, 0.5], children: side === 'left' || side === 'top' ? [ng, target] : [target, ng] };
    const info = parentOf(lay.tree, target);
    if (info) info.parent.children[info.index] = node; else lay.tree = node;
    return ng;
  }

  // ------------------------------------------------------------------ persistence

  function revive(n) {
    if (!n || typeof n !== 'object') return null;
    if (Array.isArray(n.children)) {
      const pairs = n.children.map((c, i) => [revive(c), n.sizes && n.sizes[i] > 0 ? n.sizes[i] : 1]).filter(p => p[0]);
      if (!pairs.length) return null;
      return { dir: n.dir === 'col' ? 'col' : 'row', children: pairs.map(p => p[0]), sizes: renorm(pairs.map(p => p[1])) };
    }
    const tabs = (Array.isArray(n.tabs) ? n.tabs : []).filter(k => typeof k === 'string' && /^(?:[af]:|d:[sw]:)./.test(k));
    return leaf(tabs, tabs.includes(n.active) ? n.active : tabs[0] ?? null);
  }
  const dump = n => (isLeaf(n) ? { tabs: n.tabs.slice(0, 40), active: n.active } : { dir: n.dir, sizes: n.sizes, children: n.children.map(dump) });

  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const out = {};
      for (const [r, lay] of layouts) out[r] = dump(lay.tree);
      H.saveUi({ layouts: out });
    }, 300);
  }

  function init(ui) {
    legacy = { ...(ui.tabs || {}) };
    for (const [r, t] of Object.entries(ui.layouts || {})) {
      const tree = revive(t);
      if (tree) layouts.set(r, { tree: normalize(tree), focus: null, lastFile: null, lastAgent: null });
    }
  }

  function ensure(r) {
    let lay = layouts.get(r);
    if (!lay) {
      // first run with split panes: carry over the file tabs that were open before
      const files = ((legacy[r] && legacy[r].tabs) || []).map(p => `f:${p}`);
      delete legacy[r];
      lay = { tree: leaf(files, null), focus: null, lastFile: null, lastAgent: null };
      layouts.set(r, lay);
    }
    if (!lay.focus || !leafById(lay, lay.focus)) lay.focus = firstLeaf(lay).id;
    return lay;
  }
  const cur = () => (root ? ensure(root) : null);

  // ------------------------------------------------------------------ sessions <-> agent tabs

  function agentTarget(lay) {
    const ok = id => id && leafById(lay, id);
    if (ok(expectGroup)) return leafById(lay, expectGroup);
    const withAgent = [...leaves(lay.tree)].find(g => g.tabs.some(k => k.startsWith('a:')));
    return withAgent || leafById(lay, lay.focus) || firstLeaf(lay);
  }

  function reconcile(lay, ids) {
    const live = new Set(ids);
    for (const g of leaves(lay.tree)) for (const k of [...g.tabs]) if (k.startsWith('a:') && !live.has(k.slice(2))) detach(g, k);
    const placed = new Set();
    for (const g of leaves(lay.tree)) g.tabs.forEach(k => placed.add(k));
    for (const id of ids) if (!placed.has(`a:${id}`)) addAgentTab(agentTarget(lay), `a:${id}`);
    clean(lay);
  }

  function setRoot(r, ids) {
    root = r;
    if (r) {
      const lay = ensure(r);
      reconcile(lay, ids);
      const files = [...leaves(lay.tree)].flatMap(g => g.tabs).filter(k => k.startsWith('f:')).map(k => k.slice(2));
      if (files.length) E().preload(files).then(missing => missing.forEach(removeFile));
      persist();
    }
    renderRoot(true);
  }
  function sync(r, ids) {
    if (!r || r !== root) return;
    reconcile(ensure(r), ids);
    renderRoot();
    persist();
  }

  // ------------------------------------------------------------------ rendering

  /** Tab label: user's name, else the agent's name / the terminal's running command. */
  function agentLabel(info) {
    if (!info) return 'agent';
    if (info.title) return info.title;
    if (info.kind === 'terminal') return info.proc || `terminal ${info.index}`;
    return info.name || `agent ${info.index}`;
  }

  /** Double-click a tab to rename it inline; Enter saves, Esc cancels, empty resets to the default. */
  function renameTab(t) {
    const id = t.dataset.key.slice(2), info = APP().agentInfo(id), span = t.querySelector('.tname');
    if (!info || !span || t.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'tname-edit';
    input.value = info.title || agentLabel(info);
    input.size = Math.max(6, input.value.length + 1);
    span.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (save && v !== agentLabel(info)) APP().renameAgent(id, v === (info.kind === 'terminal' ? info.proc : info.name) ? '' : v);
      input.replaceWith(span);
      renderTabs();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('input', () => { input.size = Math.max(6, input.value.length + 1); });
    input.addEventListener('blur', () => finish(true));
  }

  function tabHtml(k, g) {
    const cls = `${k === g.active ? ' on' : ''}${k === dragKey ? ' dragging' : ''}`;
    if (k.startsWith('a:')) {
      const info = APP().agentInfo(k.slice(2));
      const ind = info && info.waiting
        ? '<div class="dot wait" style="width:6px;height:6px"></div>'
        : info && info.working
        ? '<div class="spin" style="width:9px;height:9px;border-width:1.6px"></div>'
        : '<div class="dot idle" style="width:6px;height:6px;box-shadow:none"></div>';
      return `<div class="gtab agent${cls}" data-key="${esc(k)}">${ind}<span class="tname">${esc(agentLabel(info))}</span><span class="gx" title="Stop agent">${X}</span></div>`;
    }
    if (k.startsWith('d:')) {
      const info = E().diffInfo(k);
      return `<div class="gtab file diff${cls}" data-key="${esc(k)}" title="${esc(info.title)}">
        <span class="tname">${esc(info.name)}</span><span class="gx ${info.dirty ? 'dirty' : ''}">${info.dirty ? '●' : '×'}</span></div>`;
    }
    const p = k.slice(2);
    const info = E().tabInfo(p);
    return `<div class="gtab file${cls}${info.errs ? ' has-err' : ''}" data-key="${esc(k)}" title="${esc(info.title)}">
      <span class="tname">${esc(info.name)}</span>${info.conflict ? '<span class="tconf" title="Changed on disk while you had unsaved edits">!</span>' : ''}
      <span class="gx ${info.dirty ? 'dirty' : ''}">${info.dirty ? '●' : '×'}</span></div>`;
  }

  function groupEl(g) {
    let ge = groupEls.get(g.id);
    if (ge) return ge;
    const el = document.createElement('div');
    el.className = 'group';
    el.dataset.id = g.id;
    el.innerHTML = `
      <div class="gbar"><div class="gtabs"></div><button class="icon-btn gnew" title="New agent or terminal (⌥⌘T)">${PLUS}</button></div>
      <div class="gbody">
        <div class="ghost" hidden></div>
        <div class="gdiff" hidden></div>
        <div class="gbinary center-msg" hidden><div class="empty-title">Binary file</div><div>This file can't be shown as text.</div></div>
        <div class="gempty center-msg" hidden>
          <div class="empty-title">Nothing open here</div>
          <button class="primary-btn gstart">Start agent</button>
          <div class="hint"></div>
          <pre class="gerr" hidden></pre>
          <div class="keys"><span><kbd>⌘P</kbd> Go to file</span><span><kbd>⌘⌥B</kbd> Toggle file tree</span><span><kbd>⌘B</kbd> Toggle sidebar</span></div>
        </div>
      </div>`;
    ge = {
      el, tabs: el.querySelector('.gtabs'), body: el.querySelector('.gbody'), host: el.querySelector('.ghost'), diffHost: el.querySelector('.gdiff'),
      binary: el.querySelector('.gbinary'), empty: el.querySelector('.gempty'), tok: 0, mounted: null, pending: null, html: '', shown: null,
    };
    groupEls.set(g.id, ge);
    el.addEventListener('mousedown', () => setFocus(g.id), true);
    el.querySelector('.gnew').onclick = e => {
      const r = e.currentTarget.getBoundingClientRect();
      E().showContextMenu(r.left, r.bottom + 4, [
        { label: 'Claude Code', run: () => APP().newAgent(g.id) },
        { label: 'Terminal', run: () => APP().newAgent(g.id, 'terminal') },
      ]);
    };
    el.querySelector('.gstart').onclick = () => APP().newAgent(g.id);
    ge.tabs.addEventListener('click', e => {
      const t = e.target.closest('.gtab');
      if (!t) return;
      if (e.target.closest('.gx')) { e.stopPropagation(); closeKey(t.dataset.key); } else activate(g, t.dataset.key);
    });
    ge.tabs.addEventListener('dblclick', e => {
      const t = e.target.closest('.gtab.agent');
      if (t && !e.target.closest('.gx')) renameTab(t);
    });
    ge.tabs.addEventListener('mousedown', e => {
      const t = e.target.closest('.gtab');
      if (!t || e.target.closest('input')) return;
      if (e.button === 1) { e.preventDefault(); closeKey(t.dataset.key); return; }
      if (e.button !== 0 || e.target.closest('.gx')) return;
      beginDrag(e, t.dataset.key, t.querySelector('.tname').textContent);
    });
    return ge;
  }

  async function mount(g, ge, path) {
    const tok = ++ge.tok;
    const m = await E().show(g.id, ge.host, path);
    if (tok !== ge.tok) return g.id;
    if (!m || m.error) { ge.mounted = null; removeFile(path); return null; }
    ge.host.hidden = !m.model;
    ge.binary.hidden = !m.binary;
    if (m.model) E().layoutGroup(g.id);
    return g.id;
  }

  async function mountDiff(g, ge, key) {
    const tok = ++ge.tok;
    const m = await E().showDiff(g.id, ge.diffHost, key);
    if (tok !== ge.tok) return g.id;
    if (!m || m.error) { ge.mounted = null; removeKey(key); return null; }
    ge.diffHost.hidden = !!m.binary;
    ge.binary.hidden = !m.binary;
    if (!m.binary) E().layoutGroup(g.id);
    return g.id;
  }

  function renderGroup(lay, g) {
    const ge = groupEl(g);
    ge.el.classList.toggle('focused', lay.focus === g.id);
    const html = g.tabs.map(k => tabHtml(k, g)).join('');
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
    if (act && act.startsWith('f:')) {
      ge.host.hidden = false;
      ge.diffHost.hidden = true;
      if (ge.mounted !== act) { ge.mounted = act; ge.pending = mount(g, ge, act.slice(2)); }
    } else if (act && act.startsWith('d:')) {
      ge.host.hidden = true;
      ge.diffHost.hidden = false;
      if (ge.mounted !== act) { ge.mounted = act; ge.pending = mountDiff(g, ge, act); }
    } else {
      ge.mounted = null;
      ge.host.hidden = true;
      ge.diffHost.hidden = true;
      ge.binary.hidden = true;
    }
    ge.empty.hidden = g.tabs.length > 0;
    if (!g.tabs.length) {
      const s = APP().agentHint();
      ge.empty.querySelector('.hint').textContent = s.hint;
      const err = ge.empty.querySelector('.gerr');
      err.hidden = !s.error;
      err.textContent = s.error || '';
      ge.empty.querySelector('.gstart').hidden = !root;
    }
  }

  const sigOf = n => (isLeaf(n) ? n.id : `${n.dir}(${n.children.map(sigOf).join(',')})`);

  function buildNode(n) {
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

  function splitter(n, i, splitEl) {
    const s = document.createElement('div');
    s.className = `gsplit ${n.dir}`;
    s.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      const row = n.dir === 'row';
      const total = row ? splitEl.clientWidth : splitEl.clientHeight;
      const kids = [...splitEl.children].filter(x => !x.classList.contains('gsplit'));
      const a0 = n.sizes[i], b0 = n.sizes[i + 1], start = row ? e.clientX : e.clientY;
      const min = Math.min(MIN_PX / total, (a0 + b0) / 2);
      s.classList.add('drag-on');
      const mv = ev => {
        const a = Math.max(min, Math.min(a0 + b0 - min, a0 + ((row ? ev.clientX : ev.clientY) - start) / total));
        n.sizes[i] = a; n.sizes[i + 1] = a0 + b0 - a;
        kids[i].style.flex = `${n.sizes[i]} 1 0%`;
        kids[i + 1].style.flex = `${n.sizes[i + 1]} 1 0%`;
      };
      const up = () => {
        removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true);
        s.classList.remove('drag-on');
        persist();
      };
      addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true);
    });
    return s;
  }

  function renderRoot(force) {
    const c = $('#layoutRoot');
    if (!root) { c.replaceChildren(); structSig = ''; gc(); return; }
    const lay = ensure(root);
    const sig = `${root}|${sigOf(lay.tree)}`;
    if (force || sig !== structSig) {
      structSig = sig;
      const top = buildNode(lay.tree);
      top.style.flex = '1 1 0%';
      c.replaceChildren(top);
      for (const ge of groupEls.values()) ge.el.classList.remove('tl');
      groupEls.get(firstLeaf(lay).id).el.classList.add('tl');
      c.classList.toggle('multi', !isLeaf(lay.tree));
    }
    for (const g of leaves(lay.tree)) renderGroup(lay, g);
    gc();
    E().groupFocused(lay.focus);
    APP().markSidebar();
    requestAnimationFrame(() => APP().fitAll());
  }

  /** Forget DOM/editors of groups that no longer exist in any worktree's layout. */
  function gc() {
    const live = new Set();
    for (const lay of layouts.values()) for (const g of leaves(lay.tree)) live.add(g.id);
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
      const html = g.tabs.map(k => tabHtml(k, g)).join('');
      if (html !== ge.html) ge.tabs.innerHTML = ge.html = html;
    }
  }

  // ------------------------------------------------------------------ actions

  function setFocus(id) {
    const lay = cur();
    if (!lay || !leafById(lay, id)) return;
    lay.focus = id;
    for (const g of leaves(lay.tree)) groupEls.get(g.id)?.el.classList.toggle('focused', g.id === id);
    noteKind(lay, leafById(lay, id));
    E().groupFocused(id);
  }
  function noteKind(lay, g) {
    if (!g.active) return;
    if (g.active.startsWith('a:')) lay.lastAgent = g.active; else lay.lastFile = g.id;
  }

  function activate(g, key) {
    const lay = cur();
    g.active = key;
    lay.focus = g.id;
    noteKind(lay, g);
    renderRoot();
    persist();
    afterActivate(g, key);
  }
  function afterActivate(g, key) {
    if (key.startsWith('a:')) APP().focusTerm(key.slice(2));
    else E().focusGroup(g.id);
  }

  function closeKey(key) {
    if (key.startsWith('f:')) E().closeTab(key.slice(2));
    else if (key.startsWith('d:')) E().closeDiff(key);
    else APP().stopAgent(key.slice(2));
  }

  const removeFile = path => removeKey(`f:${path}`);
  function removeKey(key) {
    for (const lay of layouts.values()) {
      const g = groupOf(lay, key);
      if (!g) continue;
      detach(g, key);
      clean(lay);
    }
    renderRoot();
    persist();
  }

  async function openFile(path, opts = {}) { return openKey(`f:${path}`, opts); }
  async function openDiff(mode, path, opts = {}) { return openKey(`d:${mode}:${path}`, opts); }

  async function openKey(key, { focus = true } = {}) {
    const lay = cur();
    if (!lay) return null;
    let g = groupOf(lay, key);
    if (!g) {
      g = leafById(lay, lay.lastFile) || leafById(lay, lay.focus);
      const at = g.active && g.tabs.includes(g.active) ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
      g.tabs.splice(at, 0, key);
    }
    g.active = key;
    if (focus) lay.focus = g.id;
    lay.lastFile = g.id;
    renderRoot();
    persist();
    const ge = groupEls.get(g.id);
    return ge && ge.pending ? ge.pending : g.id;
  }

  function revealAgent(id) {
    const lay = cur();
    const key = `a:${id}`;
    const g = lay && groupOf(lay, key);
    if (!g) return;
    g.active = key;
    lay.focus = g.id;
    noteKind(lay, g);
    renderRoot();
    persist();
  }

  /** Agent/terminal ids that are the visible tab of some pane in the current worktree. */
  function visibleAgents() {
    const lay = cur();
    return lay ? [...leaves(lay.tree)].map(g => g.active).filter(k => k && k.startsWith('a:')).map(k => k.slice(2)) : [];
  }

  function currentAgent() {
    const lay = cur();
    if (!lay) return null;
    const g = leafById(lay, lay.focus);
    if (g && g.active && g.active.startsWith('a:')) return g.active.slice(2);
    if (lay.lastAgent && groupOf(lay, lay.lastAgent)) return lay.lastAgent.slice(2);
    const any = [...leaves(lay.tree)].flatMap(x => x.tabs).find(k => k.startsWith('a:'));
    return any ? any.slice(2) : null;
  }

  function activeFile() {
    const lay = cur();
    const g = lay && leafById(lay, lay.focus);
    return g && g.active && g.active.startsWith('f:') ? g.active.slice(2) : null;
  }
  const activeKey = () => { const lay = cur(), g = lay && leafById(lay, lay.focus); return g ? g.active : null; };

  /** Focus the editor most recently used; false if no group shows a file. */
  function focusEditor() {
    const lay = cur();
    if (!lay) return false;
    const showing = g => g && g.active && g.active.startsWith('f:');
    const g = [leafById(lay, lay.focus), leafById(lay, lay.lastFile), ...leaves(lay.tree)].find(showing);
    if (!g) return false;
    lay.focus = g.id;
    renderRoot();
    afterActivate(g, g.active);
    return true;
  }

  const hasKey = key => [...layouts.values()].some(lay => !!groupOf(lay, key));
  const hasFile = path => hasKey(`f:${path}`) || hasKey(`d:w:${path}`);
  const diffKeys = r => (layouts.has(r) ? [...leaves(layouts.get(r).tree)].flatMap(g => g.tabs).filter(k => k.startsWith('d:')) : []);
  const filesOf = r => (layouts.has(r) ? [...leaves(layouts.get(r).tree)].flatMap(g => g.tabs).filter(k => k.startsWith('f:')).map(k => k.slice(2)) : []);

  function forgetRoot(r) {
    layouts.delete(r);
    delete legacy[r];
    if (r === root) { root = null; renderRoot(true); }
    gc();
    persist();
  }

  // ------------------------------------------------------------------ drag & drop of tabs

  /** Where would a tab dropped at the pointer land? */
  function dropAt(ev, key, src) {
    const lay = cur();
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const ge = el && el.closest('.group');
    const g = ge && lay && leafById(lay, ge.dataset.id);
    if (!g) return null;
    const bar = ge.querySelector('.gbar').getBoundingClientRect();
    if (ev.clientY < bar.bottom) {
      const tabs = [...ge.querySelectorAll('.gtab')].filter(t => t.dataset.key !== key);
      const index = tabs.filter(t => { const r = t.getBoundingClientRect(); return ev.clientX > r.left + r.width / 2; }).length;
      const ref = tabs[Math.min(index, tabs.length - 1)];
      const rr = ref ? ref.getBoundingClientRect() : null;
      const x = !rr ? bar.left + 6 : index < tabs.length ? rr.left - 1 : rr.right + 1;
      return { g, kind: 'tab', index, bar: { x, top: bar.top + 4, h: bar.height - 8 } };
    }
    const b = ge.querySelector('.gbody').getBoundingClientRect();
    const rx = (ev.clientX - b.left) / b.width, ry = (ev.clientY - b.top) / b.height;
    const d = { left: rx, right: 1 - rx, top: ry, bottom: 1 - ry };
    const side = Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), 'left');
    const lone = src === g && g.tabs.length <= 1;
    if (d[side] < EDGE && !lone) {
      const rect = {
        left: [b.left, b.top, b.width / 2, b.height], right: [b.left + b.width / 2, b.top, b.width / 2, b.height],
        top: [b.left, b.top, b.width, b.height / 2], bottom: [b.left, b.top + b.height / 2, b.width, b.height / 2],
      }[side];
      return { g, kind: 'edge', side, rect };
    }
    if (src === g) return null;
    return { g, kind: 'center', rect: [b.left, b.top, b.width, b.height] };
  }

  function beginDrag(e0, key, label) {
    const lay = cur();
    const src = lay && groupOf(lay, key);
    let hint, bar, ghost, drop = null;
    const mk = cls => { const d = document.createElement('div'); d.className = cls; document.body.appendChild(d); return d; };
    window.harborDnd.track(e0, {
      onStart() {
        hint = mk('drop-hint'); bar = mk('drop-bar'); ghost = mk('drag-ghost');
        hint.hidden = bar.hidden = true;
        ghost.textContent = label;
        dragKey = key;
        renderTabs();
      },
      onMove(ev) {
        ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
        drop = dropAt(ev, key, src);
        hint.hidden = !drop || drop.kind === 'tab';
        bar.hidden = !drop || drop.kind !== 'tab';
        if (!drop) return;
        if (drop.kind === 'tab') bar.style.cssText = `left:${drop.bar.x}px;top:${drop.bar.top}px;height:${drop.bar.h}px`;
        else { const [l, t, w, h] = drop.rect; hint.style.cssText = `left:${l + 4}px;top:${t + 4}px;width:${w - 8}px;height:${h - 8}px`; }
      },
      onEnd(_ev, moved, cancelled) {
        for (const x of [hint, bar, ghost]) if (x) x.remove();
        if (!moved) return;
        dragKey = null;
        if (!cancelled && drop) moveTab(key, drop); else renderTabs();
      },
    });
  }

  /** Start dragging something that is not a tab yet (e.g. a row of the file tree). */
  function dragFile(e, path, label) { beginDrag(e, `f:${path}`, label); }

  function moveTab(key, drop) {
    const lay = cur();
    const src = groupOf(lay, key);
    const tgt = drop.g;
    if (drop.kind === 'edge' && src === tgt && tgt.tabs.length <= 1) return;
    if (src && key.startsWith('f:')) E().saveView(src.id, key.slice(2));
    if (src) detach(src, key);
    let dest = tgt;
    if (drop.kind === 'edge') dest = splitGroup(lay, tgt, drop.side, key);
    else attach(tgt, key, drop.kind === 'tab' ? drop.index : null);
    clean(lay);
    lay.focus = dest.id;
    noteKind(lay, dest);
    if (key.startsWith('f:')) lay.lastFile = dest.id;
    renderRoot();
    persist();
    afterActivate(dest, key);
  }

  /** Activate the previous/next tab of the focused group, wrapping around. */
  function cycleTab(dir) {
    const lay = cur();
    const g = lay && leafById(lay, lay.focus);
    if (!g || g.tabs.length < 2) return;
    const i = g.tabs.indexOf(g.active);
    activate(g, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
  }

  /** Move the focused group's active tab to the neighbouring group (dir -1/+1), splitting off a new one at the end. */
  function moveActive(dir) {
    const lay = cur();
    const src = lay && leafById(lay, lay.focus);
    const key = src && src.active;
    if (!key) return;
    const all = [...leaves(lay.tree)];
    const tgt = all[all.indexOf(src) + dir];
    if (tgt) moveTab(key, { kind: 'center', g: tgt });
    else if (src.tabs.length > 1) moveTab(key, { kind: 'edge', g: src, side: dir < 0 ? 'left' : 'right' });
  }

  window.harborLayout = {
    init, setRoot, sync, renderTabs, agentLabel, openFile, removeFile, revealAgent, currentAgent, visibleAgents, activeFile, focusEditor,
    hasFile, hasKey, filesOf, diffKeys, forgetRoot, dragFile, openDiff, removeKey, activeKey,
    moveActive, cycleTab,
    focusGroup: setFocus,
    focusedGroup: () => { const lay = cur(); return lay ? lay.focus : null; },
    expectAgent: id => { expectGroup = id; },
    closeActive() {
      const k = activeKey();
      if (k) closeKey(k);
    },
  };
})();
