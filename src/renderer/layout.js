'use strict';
// Split-pane workspace: per worktree, a list of pages; each page is a tree of tab groups (panes). A tab is an agent ('a:<session id>'), a file ('f:<path>')
// a new-tab launcher ('n:<id>', replaced by whatever it starts) or a diff ('d:s:<path>' staged: HEAD↔index, 'd:w:<path>' unstaged: index↔working tree, 'd:c:<sha>:<path>' commit: parent↔commit).
// Tabs can be dragged between groups, reordered, dropped on a group's edge to split it, or dropped on a page chip to move to that page.
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

  const workspaces = new Map();    // root -> { pages: [page], at }; page = { id, name, tree, focus, lastFile, lastAgent, zoom }
  const groupEls = new Map();      // group id -> { el, tabs, body, host, binary, empty, tok, mounted, pending, html, shown }
  let root = null, seq = 0, legacy = {}, expectGroup = null, expectReplace = null, structSig = '', dragKey = null;

  // ------------------------------------------------------------------ tree

  const nid = () => `g${++seq}`;
  const leaf = (tabs = [], active = null) => ({ id: nid(), tabs, active });
  const mkPage = (tree, name = '') => ({ id: `p${++seq}`, name, tree, focus: null, lastFile: null, lastAgent: null, zoom: null });
  const pageOf = ws => ws.pages[ws.at];
  function* allLeaves(ws) { for (const p of ws.pages) yield* leaves(p.tree); }
  function* everyLeaf() { for (const ws of workspaces.values()) yield* allLeaves(ws); }
  const wsKeys = ws => [...allLeaves(ws)].flatMap(g => g.tabs);
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
    if (g.preview === key) g.preview = null;
    if (g.active === key) g.active = g.tabs[Math.min(i, g.tabs.length - 1)] ?? null;
  }
  function attach(g, key, index) {
    if (index == null || index > g.tabs.length) index = g.tabs.length;
    g.tabs.splice(index, 0, key);
    g.active = key;
  }
  function addAgentTab(g, key) {
    const i = expectReplace ? g.tabs.indexOf(expectReplace) : -1;
    if (i >= 0) {   // started from a new-tab launcher: take its place
      g.tabs[i] = key;
      g.active = key;
      expectReplace = null;
      return;
    }
    g.tabs.push(key);
    if (!g.active) g.active = key;
  }
  function splitGroup(lay, target, side, key) {
    const ng = key ? leaf([key], key) : leaf();
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
    const tabs = (Array.isArray(n.tabs) ? n.tabs : []).filter(k => typeof k === 'string' && /^(?:[afn]:|d:[swc]:)./.test(k));
    return leaf(tabs, tabs.includes(n.active) ? n.active : tabs[0] ?? null);
  }
  const dump = n => (isLeaf(n) ? { tabs: n.tabs.slice(0, 40), active: n.active } : { dir: n.dir, sizes: n.sizes, children: n.children.map(dump) });

  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const out = {};
      for (const [r, ws] of workspaces) out[r] = { at: ws.at, pages: ws.pages.map(p => ({ name: p.name, tree: dump(p.tree) })) };
      H.saveUi({ pages: out, layouts: null });
    }, 300);
  }

  function init(ui) {
    legacy = { ...(ui.tabs || {}) };
    for (const [r, w] of Object.entries(ui.pages || {})) {
      const pages = (Array.isArray(w && w.pages) ? w.pages : []).map(p => {
        const tree = revive(p && p.tree);
        return tree && mkPage(normalize(tree), typeof p.name === 'string' ? p.name.slice(0, 60) : '');
      }).filter(Boolean);
      if (pages.length) workspaces.set(r, { pages, at: Math.min(Math.max(0, (w.at | 0)), pages.length - 1) });
    }
    // before pages: one layout tree per worktree
    for (const [r, t] of Object.entries(ui.layouts || {})) {
      const tree = workspaces.has(r) ? null : revive(t);
      if (tree) workspaces.set(r, { pages: [mkPage(normalize(tree))], at: 0 });
    }
    initBar();
  }

  function wsOf(r) {
    let ws = workspaces.get(r);
    if (!ws) {
      // first run with split panes: carry over the file tabs that were open before
      const files = ((legacy[r] && legacy[r].tabs) || []).map(p => `f:${p}`);
      delete legacy[r];
      ws = { pages: [mkPage(leaf(files, null))], at: 0 };
      workspaces.set(r, ws);
    }
    const lay = pageOf(ws);
    if (!lay.focus || !leafById(lay, lay.focus)) lay.focus = firstLeaf(lay).id;
    return ws;
  }
  const ensure = r => pageOf(wsOf(r));
  const cur = () => (root ? ensure(root) : null);

  // ------------------------------------------------------------------ sessions <-> agent tabs

  function agentTarget(lay) {
    const ok = id => id && leafById(lay, id);
    if (ok(expectGroup)) return leafById(lay, expectGroup);
    const withAgent = [...leaves(lay.tree)].find(g => g.tabs.some(k => k.startsWith('a:')));
    return withAgent || leafById(lay, lay.focus) || firstLeaf(lay);
  }

  /** New agents land in the current page; agents that died are dropped from every page. */
  function reconcile(ws, ids) {
    const live = new Set(ids);
    for (const g of allLeaves(ws)) for (const k of [...g.tabs]) if (k.startsWith('a:') && !live.has(k.slice(2))) detach(g, k);
    const placed = new Set(wsKeys(ws));
    for (const id of ids) if (!placed.has(`a:${id}`)) addAgentTab(agentTarget(pageOf(ws)), `a:${id}`);
    for (const p of ws.pages) clean(p);
  }

  function setRoot(r, ids) {
    root = r;
    if (r) {
      reconcile(wsOf(r), ids);
      const files = filesOf(r);
      if (files.length) E().preload(files).then(missing => missing.forEach(removeFile));
      persist();
    }
    renderRoot(true);
  }
  function sync(r, ids) {
    if (!r || r !== root) return;
    reconcile(wsOf(r), ids);
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

  /** Rename an agent tab inline (right-click → Rename); Enter saves, Esc cancels, empty resets to the default. */
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

  const waitDot = '<div class="dot wait" style="width:6px;height:6px"></div>';
  const spinner = '<div class="spin" style="width:9px;height:9px;border-width:1.6px"></div>';

  const isDirtyKey = k => (k.startsWith('f:') ? E().tabInfo(k.slice(2)).dirty : k.startsWith('d:') ? E().diffInfo(k).dirty : false);
  const isPreviewable = k => k.startsWith('f:') || k.startsWith('d:');

  function tabHtml(k, g) {
    const cls = `${k === g.active ? ' on' : ''}${k === dragKey ? ' dragging' : ''}`;
    const prev = k === g.preview && !isDirtyKey(k) ? ' preview' : '';
    if (k.startsWith('a:')) {
      const info = APP().agentInfo(k.slice(2));
      const ind = info && info.waiting ? waitDot : info && info.working ? spinner
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

  function groupEl(g) {
    let ge = groupEls.get(g.id);
    if (ge) return ge;
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
    ge = {
      el, tabs: el.querySelector('.gtabs'), body: el.querySelector('.gbody'), host: el.querySelector('.ghost'), diffHost: el.querySelector('.gdiff'),
      binary: el.querySelector('.gbinary'), image: el.querySelector('.gimage'), launch: el.querySelector('.glaunch'), lsel: 0, litems: [], lnaming: false, tok: 0, mounted: null, pending: null, html: '', shown: null,
    };
    groupEls.set(g.id, ge);
    el.addEventListener('mousedown', () => setFocus(g.id), true);
    el.querySelector('.gnew').onclick = () => { setFocus(g.id); newTab(); };
    const lq = ge.launch.querySelector('.lq');
    lq.addEventListener('input', () => { ge.lsel = 0; renderLaunch(g); });
    lq.addEventListener('keydown', e => {
      if (e.metaKey && !e.altKey && e.key.toLowerCase() === 'a') { e.preventDefault(); lq.select(); return; }   // no Select All menu role (see commitMsg in editor.js)
      const d = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n') ? 1 : e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p') ? -1 : 0;
      if (d) {
        e.preventDefault();
        ge.lsel = Math.max(0, Math.min(ge.litems.length - 1, ge.lsel + d));
        renderLaunch(g);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (ge.lnaming) createMarkdown(g, lq.value); else runLaunch(g, ge.lsel);
      } else if (e.key === 'Escape' && ge.lnaming) {
        e.stopPropagation();
        ge.lnaming = false;
        lq.value = '';
        renderLaunch(g);
      }
    });
    // a click on the launcher's empty space keeps the input focused so arrows/typing still work
    ge.launch.addEventListener('mousedown', e => {
      if (e.target !== lq && !e.target.closest('.lopt')) { e.preventDefault(); lq.focus(); }
    });
    ge.launch.querySelector('.lopts').addEventListener('mousedown', e => {
      const row = e.target.closest('.lopt');
      if (!row) return;
      e.preventDefault();
      setFocus(g.id);
      runLaunch(g, +row.dataset.i);
    });
    ge.tabs.addEventListener('click', e => {
      const t = e.target.closest('.gtab');
      if (!t) return;
      if (e.target.closest('.gx')) { e.stopPropagation(); closeKey(t.dataset.key); } else activate(g, t.dataset.key);
    });
    // double-click a preview tab to keep it
    ge.tabs.addEventListener('dblclick', e => {
      const t = e.target.closest('.gtab');
      if (t && !e.target.closest('.gx, input') && g.preview === t.dataset.key) { g.preview = null; renderTabs(); }
    });
    // double-click the empty part of the bar to zoom the pane
    el.querySelector('.gbar').addEventListener('dblclick', e => {
      if (e.target.closest('.gx, input, .gnew')) return;
      if (e.target === e.currentTarget || e.target === ge.tabs) toggleZoom();
    });
    ge.tabs.addEventListener('contextmenu', e => {
      const t = e.target.closest('.gtab.agent');
      if (!t) return;
      e.preventDefault();
      E().showContextMenu(e.clientX, e.clientY, [{ label: 'Rename', run: () => renameTab(t) }]);
    });
    el.querySelector('.gbar').addEventListener('mousedown', e => {
      if (e.button === 0 && e.target === e.currentTarget && g.tabs.length) beginGroupDrag(e, g);
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

  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|avif)$/i;

  async function mount(g, ge, path) {
    const tok = ++ge.tok;
    const m = await E().show(g.id, ge.host, path);
    if (tok !== ge.tok) return g.id;
    if (!m || m.error) { ge.mounted = null; removeFile(path); return null; }
    ge.host.hidden = !m.model;
    const img = m.binary && IMAGE_EXT.test(path);
    if (img) ge.image.firstChild.src = 'file://' + encodeURI(path).replace(/[#?]/g, encodeURIComponent);
    ge.image.hidden = !img;
    ge.binary.hidden = !m.binary || img;
    if (m.model) E().layoutGroup(g.id);
    return g.id;
  }

  async function mountDiff(g, ge, key) {
    const tok = ++ge.tok;
    const m = await E().showDiff(g.id, ge.diffHost, key);
    if (tok !== ge.tok) return g.id;
    if (!m || m.error) { ge.mounted = null; removeKey(key); return null; }
    ge.diffHost.hidden = !!m.binary;
    ge.image.hidden = true;
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
      ge.image.hidden = true;
      if (ge.mounted !== act) { ge.mounted = act; ge.pending = mountDiff(g, ge, act); }
    } else {
      ge.mounted = null;
      ge.host.hidden = true;
      ge.diffHost.hidden = true;
      ge.image.hidden = true;
      ge.binary.hidden = true;
    }
    const launching = act ? act.startsWith('n:') : !!root;   // an empty pane is a launcher too
    if (launching && ge.launch.hidden) { ge.lsel = 0; ge.lnaming = false; ge.launch.querySelector('.lq').value = ''; renderLaunch(g); }
    ge.launch.hidden = !launching;
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
    if (!root) { c.replaceChildren(); structSig = ''; gc(); renderPageBar(); return; }
    const lay = ensure(root);
    const sig = `${root}|${lay.id}|${sigOf(lay.tree)}`;
    if (force || sig !== structSig) {
      structSig = sig;
      const top = buildNode(lay.tree);
      top.style.flex = '1 1 0%';
      c.replaceChildren(top);
      for (const ge of groupEls.values()) ge.el.classList.remove('tl');
      groupEls.get(firstLeaf(lay).id).el.classList.add('tl');
      c.classList.toggle('multi', !isLeaf(lay.tree));
    }
    // zoom ends when the pane goes away, is the only one left, or focus moves to another pane
    if (lay.zoom && (isLeaf(lay.tree) || lay.zoom !== lay.focus || !leafById(lay, lay.zoom))) lay.zoom = null;
    c.classList.toggle('zoomed', !!lay.zoom);
    for (const [id, ge] of groupEls) ge.el.classList.toggle('zoomed', id === lay.zoom);
    for (const g of leaves(lay.tree)) renderGroup(lay, g);
    gc();
    renderPageBar();
    E().groupFocused(lay.focus);
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
      const html = g.tabs.map(k => tabHtml(k, g)).join('');
      if (html !== ge.html) ge.tabs.innerHTML = ge.html = html;
    }
    renderPageBar();
  }

  // ------------------------------------------------------------------ pages

  const pageLabel = (p, i) => p.name || `Page ${i + 1}`;
  let barHtml = '';

  /** Strip of page chips under the panes; a chip shows a spinner / dot while an agent in that page works / waits. */
  function renderPageBar() {
    const bar = $('#pageBar');
    const ws = root && workspaces.get(root);
    bar.hidden = !ws;
    if (!ws || bar.querySelector('input')) return;
    const html = ws.pages.map((p, i) => {
      const infos = [...leaves(p.tree)].flatMap(g => g.tabs).filter(k => k.startsWith('a:')).map(k => APP().agentInfo(k.slice(2)));
      const ind = infos.some(x => x && x.waiting) ? waitDot : infos.some(x => x && x.working) ? spinner : '';
      return `<div class="pchip${i === ws.at ? ' on' : ''}" data-i="${i}">${ind}<span class="tname">${esc(pageLabel(p, i))}</span>${
        ws.pages.length > 1 ? `<span class="gx" title="Close page (tabs move to a neighbour)">${X}</span>` : ''}</div>`;
    }).join('') + `<button class="icon-btn pnew" title="New page (⌥⇧⌘N)">${PLUS}</button>`;
    if (html !== barHtml) bar.innerHTML = barHtml = html;
  }

  function initBar() {
    const bar = $('#pageBar');
    bar.addEventListener('click', e => {
      if (e.target.closest('.pnew')) return newPage();
      const c = e.target.closest('.pchip');
      if (!c || e.target.closest('input')) return;
      if (e.target.closest('.gx')) closePage(+c.dataset.i); else setPage(+c.dataset.i);
    });
    bar.addEventListener('dblclick', e => {
      const c = e.target.closest('.pchip');
      if (c && !e.target.closest('.gx, input')) renamePage(+c.dataset.i);
    });
    bar.addEventListener('mousedown', e => {
      const c = e.target.closest('.pchip');
      if (e.button === 1 && c) { e.preventDefault(); closePage(+c.dataset.i); }
    });
    bar.addEventListener('contextmenu', e => {
      const c = e.target.closest('.pchip');
      e.preventDefault();
      const i = c ? +c.dataset.i : null;
      const items = [{ label: 'New Page', run: newPage }];
      if (i != null) items.unshift({ label: 'Rename', run: () => renamePage(i) }, { label: 'Close Page', run: () => closePage(i) });
      E().showContextMenu(e.clientX, e.clientY, items);
    });
  }

  function setPage(i) {
    const ws = root && workspaces.get(root);
    if (!ws || i < 0 || i >= ws.pages.length || i === ws.at) return;
    ws.at = i;
    renderRoot();
    persist();
    const lay = pageOf(ws);
    focusGroup(leafById(lay, lay.focus) || firstLeaf(lay));
  }
  const cyclePage = dir => {
    const ws = root && workspaces.get(root);
    if (ws && ws.pages.length > 1) setPage((ws.at + dir + ws.pages.length) % ws.pages.length);
  };

  /** Add an empty page right after the current one and switch to it. */
  function newPage() {
    const ws = root && wsOf(root);
    if (!ws) return;
    const p = mkPage(leaf());
    p.focus = firstLeaf(p).id;
    ws.pages.splice(ws.at + 1, 0, p);
    ws.at++;
    renderRoot();
    persist();
    focusGroup(firstLeaf(p));
  }

  /** Remove a page; its tabs move into the focused pane of the previous page (the next one for the first page). */
  function closePage(i) {
    const ws = root && workspaces.get(root);
    if (!ws || ws.pages.length < 2 || !ws.pages[i]) return;
    const p = ws.pages[i], into = ws.pages[i ? i - 1 : 1];
    const dest = leafById(into, into.focus) || firstLeaf(into);
    for (const g of leaves(p.tree)) {
      for (const k of g.tabs) if (k.startsWith('f:')) E().saveView(g.id, k.slice(2));
      dest.tabs.push(...g.tabs);
      if (!dest.active) dest.active = g.active;
    }
    ws.pages.splice(i, 1);
    ws.at = ws.pages.indexOf(into);
    clean(into);
    into.focus = dest.id;
    renderRoot();
    persist();
    focusGroup(dest);
  }

  /** Rename a page chip inline; Enter saves, Esc cancels, empty resets to "Page N". */
  function renamePage(i) {
    const ws = root && workspaces.get(root);
    const chip = $('#pageBar').querySelector(`.pchip[data-i="${i}"]`);
    const span = chip && chip.querySelector('.tname');
    if (!ws || !ws.pages[i] || !span || chip.querySelector('input')) return;
    const input = document.createElement('input');
    input.className = 'tname-edit';
    input.value = ws.pages[i].name || pageLabel(ws.pages[i], i);
    input.size = Math.max(6, input.value.length + 1);
    span.replaceWith(input);
    input.focus(); input.select();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      const v = input.value.trim().slice(0, 60);
      if (save) { ws.pages[i].name = v === `Page ${i + 1}` ? '' : v; persist(); }
      input.replaceWith(span);
      barHtml = '';
      renderPageBar();
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('input', () => { input.size = Math.max(6, input.value.length + 1); });
    input.addEventListener('blur', () => finish(true));
  }

  // ------------------------------------------------------------------ actions

  function setFocus(id) {
    const lay = cur();
    if (!lay || !leafById(lay, id)) return;
    lay.focus = id;
    for (const g of leaves(lay.tree)) groupEls.get(g.id)?.el.classList.toggle('focused', g.id === id);
    noteKind(lay, leafById(lay, id));
    E().groupFocused(id);
    APP().markSidebar();
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
    else if (key.startsWith('n:')) groupEls.get(g.id)?.launch.querySelector('.lq').focus();
    else E().focusGroup(g.id);
  }

  function closeKey(key) {
    if (key.startsWith('f:')) E().closeTab(key.slice(2));
    else if (key.startsWith('d:')) E().closeDiff(key);
    else if (key.startsWith('n:')) removeKey(key);
    else APP().stopAgent(key.slice(2));
  }

  const removeFile = path => removeKey(`f:${path}`);
  function removeKey(key) {
    for (const ws of workspaces.values()) {
      for (const lay of ws.pages) {
        const g = groupOf(lay, key);
        if (!g) continue;
        detach(g, key);
        clean(lay);
      }
    }
    renderRoot();
    persist();
  }

  async function openFile(path, opts = {}) { return openKey(`f:${path}`, opts); }
  async function openDiff(mode, path, opts = {}) { return openKey(`d:${mode}:${path}`, opts); }

  async function openKey(key, { focus = true, preview = false, pin = false } = {}) {
    let lay = cur();
    if (!lay) return null;
    let g = groupOf(lay, key);
    if (!g) {
      // already open in another page of this workspace: go there
      const ws = workspaces.get(root), other = ws.pages.find(p => groupOf(p, key));
      if (other) {
        g = groupOf(other, key);
        if (focus) { ws.at = ws.pages.indexOf(other); lay = other; }
      }
    }
    if (!g) {
      g = leafById(lay, lay.lastFile) || leafById(lay, lay.focus);
      const old = g.preview && g.tabs.includes(g.preview) ? g.preview : null;
      if (old && preview && isPreviewable(old) && !isDirtyKey(old)) {
        // a new preview replaces the previous one in place
        g.tabs[g.tabs.indexOf(old)] = key;
        g.preview = key;
        if (old.startsWith('f:')) E().dropPath(old.slice(2));
        else E().dropDiff(old);
      } else {
        const at = g.active && g.tabs.includes(g.active) ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
        g.tabs.splice(at, 0, key);
        g.preview = preview ? key : null;
      }
    } else if (pin && g.preview === key) g.preview = null;
    g.active = key;
    if (focus) lay.focus = g.id;
    if (leafById(lay, g.id)) lay.lastFile = g.id;
    renderRoot();
    persist();
    const ge = groupEls.get(g.id);
    return ge && ge.pending ? ge.pending : g.id;
  }

  function revealAgent(id) {
    const ws = root && workspaces.get(root);
    const key = `a:${id}`;
    const lay = ws && ws.pages.find(p => groupOf(p, key));
    if (!lay) return;
    ws.at = ws.pages.indexOf(lay);
    const g = groupOf(lay, key);
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
    const any = [...leaves(lay.tree)].flatMap(x => x.tabs).find(k => k.startsWith('a:')) || wsKeys(workspaces.get(root)).find(k => k.startsWith('a:'));
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

  /** Zoom the focused pane to fill the workspace view (or restore). Other panes stay mounted underneath. */
  function toggleZoom() {
    const lay = cur();
    if (!lay) return;
    if (lay.zoom) lay.zoom = null;
    else if (!isLeaf(lay.tree)) lay.zoom = lay.focus;
    else return;
    renderRoot();
    const g = leafById(lay, lay.focus);
    if (g && g.active) afterActivate(g, g.active);
  }

  /** Overlay a number on each visible pane; the digit pressed focuses that pane. Triggering again cycles to the next pane. */
  let pickOff = null;
  function pickPane() {
    const lay = cur();
    if (!lay) return;
    const rectOf = g => groupEls.get(g.id).el.getBoundingClientRect();
    // visual order: rows top to bottom, left to right within a row
    const gs = [...leaves(lay.tree)].filter(g => { const r = groupEls.has(g.id) && rectOf(g); return r && r.width && r.height; })
      .sort((a, b) => { const ra = rectOf(a), rb = rectOf(b); return Math.abs(ra.top - rb.top) > 8 ? ra.top - rb.top : ra.left - rb.left; });
    if (gs.length < 2) return;
    if (pickOff) {
      const next = gs[(gs.findIndex(g => g.id === lay.focus) + 1) % gs.length];
      pickOff();
      return focusGroup(next);
    }
    const badges = gs.slice(0, 9).map((g, i) => {
      const r = rectOf(g);
      const b = document.createElement('div');
      b.className = 'pane-pick' + (g.id === lay.focus ? ' cur' : '');
      b.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
      b.innerHTML = `<span>${i + 1}</span>`;
      document.body.appendChild(b);
      return b;
    });
    const off = () => {
      pickOff = null;
      badges.forEach(b => b.remove());
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', off, true);
      window.removeEventListener('blur', off);
    };
    const onKey = e => {
      if (e.metaKey && e.code === 'KeyJ') return; // re-trigger handled by the menu accelerator
      e.preventDefault();
      e.stopPropagation();
      off();
      const n = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
      if (n && !e.metaKey && !e.ctrlKey && !e.altKey && gs[n[1] - 1]) focusGroup(gs[n[1] - 1]);
    };
    pickOff = off;
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', off, true);
    window.addEventListener('blur', off);
  }
  function focusGroup(g) {
    setFocus(g.id);
    if (g.active) afterActivate(g, g.active);
    else groupEls.get(g.id)?.launch.querySelector('.lq').focus();
  }

  const hasKey = key => [...everyLeaf()].some(g => g.tabs.includes(key));
  const hasFile = path => hasKey(`f:${path}`) || hasKey(`d:w:${path}`);
  const diffKeys = r => (workspaces.has(r) ? wsKeys(workspaces.get(r)).filter(k => k.startsWith('d:')) : []);
  const filesOf = r => (workspaces.has(r) ? wsKeys(workspaces.get(r)).filter(k => k.startsWith('f:')).map(k => k.slice(2)) : []);

  function forgetRoot(r) {
    workspaces.delete(r);
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
    const chip = el && el.closest('.pchip');
    if (chip && lay && +chip.dataset.i !== workspaces.get(root).at) {
      const r = chip.getBoundingClientRect();
      return { kind: 'page', page: +chip.dataset.i, rect: [r.left - 4, r.top - 4, r.width + 8, r.height + 8] };
    }
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

  /** Drag a whole pane (grab the empty part of its tab bar) onto another pane to merge all its tabs into it. */
  function beginGroupDrag(e0, g) {
    let hint, ghost, target = null;
    const mk = cls => { const d = document.createElement('div'); d.className = cls; document.body.appendChild(d); return d; };
    window.harborDnd.track(e0, {
      onStart() {
        hint = mk('drop-hint'); ghost = mk('drag-ghost');
        hint.hidden = true;
        ghost.textContent = `${g.tabs.length} tab${g.tabs.length === 1 ? '' : 's'}`;
      },
      onMove(ev) {
        ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 14}px)`;
        const lay = cur();
        const ge = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.group');
        const t = ge && lay && leafById(lay, ge.dataset.id);
        target = t && t !== g ? t : null;
        hint.hidden = !target;
        if (!target) return;
        const r = ge.getBoundingClientRect();
        hint.style.cssText = `left:${r.left + 4}px;top:${r.top + 4}px;width:${r.width - 8}px;height:${r.height - 8}px`;
      },
      onEnd(_ev, moved, cancelled) {
        for (const x of [hint, ghost]) if (x) x.remove();
        if (moved && !cancelled && target) mergeGroup(g, target);
      },
    });
  }

  function mergeGroup(src, tgt) {
    const lay = cur();
    const active = src.active;
    for (const k of src.tabs) if (k.startsWith('f:')) E().saveView(src.id, k.slice(2));
    tgt.tabs.push(...src.tabs);
    src.tabs = [];
    tgt.active = active;
    clean(lay);
    lay.focus = tgt.id;
    noteKind(lay, tgt);
    if (tgt.tabs.some(k => k.startsWith('f:'))) lay.lastFile = tgt.id;
    renderRoot();
    persist();
    if (active) afterActivate(tgt, active);
  }

  /** Start dragging something that is not a tab yet (e.g. a row of the file tree). */
  function dragFile(e, path, label) { beginDrag(e, `f:${path}`, label); }

  function moveTab(key, drop) {
    const lay = cur();
    const src = groupOf(lay, key);
    if (drop.kind === 'page') return moveToPage(key, src, drop.page);
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

  /** Move a tab into the focused pane of another page and switch there. */
  function moveToPage(key, src, i) {
    const ws = workspaces.get(root), lay = pageOf(ws), tp = ws.pages[i];
    if (!tp || tp === lay) return;
    if (src && key.startsWith('f:')) E().saveView(src.id, key.slice(2));
    if (src) detach(src, key);
    const dest = leafById(tp, tp.focus) || firstLeaf(tp);
    attach(dest, key);
    clean(lay);
    ws.at = i;
    tp.focus = dest.id;
    noteKind(tp, dest);
    if (key.startsWith('f:')) tp.lastFile = dest.id;
    renderRoot();
    persist();
    afterActivate(dest, key);
  }

  /** Split the focused pane with an empty one on `side`; the next opened file lands there. */
  function splitFocused(side) {
    const lay = cur();
    const src = lay && leafById(lay, lay.focus);
    if (!src) return;
    const ng = splitGroup(lay, src, side, null);
    lay.zoom = null;
    lay.focus = lay.lastFile = ng.id;
    renderRoot();
    persist();
    focusGroup(ng);
    return ng;
  }

  /** Close the focused pane when it has no tabs (the last pane of a page stays). */
  function closeEmptyPane() {
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
    renderRoot();
    persist();
    focusGroup(leafById(lay, lay.focus));
  }

  /** Open a new-tab launcher after the focused pane's active tab (or focus the one already there). */
  function newTab() {
    const lay = cur();
    const g = lay && leafById(lay, lay.focus);
    if (!g) return null;
    if (g.active && g.active.startsWith('n:')) { afterActivate(g, g.active); return g; }
    const key = `n:${Date.now().toString(36)}${(++seq).toString(36)}`;
    const at = g.active && g.tabs.includes(g.active) ? g.tabs.indexOf(g.active) + 1 : g.tabs.length;
    g.tabs.splice(at, 0, key);
    g.active = key;
    noteKind(lay, g);
    renderRoot();
    persist();
    afterActivate(g, key);
    return g;
  }

  const LAUNCH_KINDS = [
    { k: 'terminal', label: 'Terminal', alias: ['terminal', 'term', 'shell'] },
    { k: 'agent', label: 'Claude Code', alias: ['claude', 'claude code', 'agent', 'code'] },
    { k: 'md', label: 'Markdown file', alias: ['markdown', 'md', 'note', 'new file'] },
  ];

  /** Rebuild the launcher's rows: matching kinds, then files by fuzzy name, then "create <name>". */
  function renderLaunch(g) {
    const ge = groupEls.get(g.id);
    if (!ge) return;
    const lq = ge.launch.querySelector('.lq'), list = ge.launch.querySelector('.lopts');
    ge.launch.querySelector('.gerr').hidden = true;
    if (ge.lnaming) {
      lq.placeholder = 'File name, e.g. notes.md';
      ge.litems = [];
      list.innerHTML = '<div class="lopt qi muted">Enter to create it in the worktree root · Esc to go back</div>';
      return;
    }
    lq.placeholder = 'Terminal, Claude, Markdown, or a file name…';
    const raw = lq.value, q = raw.trim().toLowerCase();
    const items = LAUNCH_KINDS
      .filter(x => !q || x.alias.some(a => a.startsWith(q)) || x.label.toLowerCase().includes(q))
      .map(x => ({ kind: true, html: `<span>${esc(x.label)}</span>`, run: () => (x.k === 'md' ? askMarkdownName(g) : APP().newAgent(g.id, x.k)) }));
    if (!E().fileIndexLoaded()) E().loadFileIndex().then(() => { if (!ge.launch.hidden && !ge.lnaming) renderLaunch(g); });
    else {
      const files = E().fileMatches(raw).slice(0, !q ? 5 : items.length ? 4 : 8);
      for (const r of files) items.push({ html: E().fileRowHtml(r), run: () => openFromLauncher(g, r) });
      const name = raw.trim();
      if (name && !items.some(it => it.kind) && !/[\/\\:]/.test(name) && !files.some(r => r.f === name)) items.push({ html: `<span>Create <b>${esc(name)}</b></span>`, run: () => createMarkdown(g, name) });
    }
    ge.litems = items;
    ge.lsel = Math.min(ge.lsel, Math.max(0, items.length - 1));
    list.innerHTML = items.map((it, i) => `<div class="lopt qi${i === ge.lsel ? ' sel' : ''}" data-i="${i}">${it.html}</div>`).join('') || '<div class="lopt qi muted">No matches</div>';
    list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }
  function runLaunch(g, i) {
    const ge = groupEls.get(g.id), it = ge && ge.litems[i];
    if (it) Promise.resolve().then(it.run).catch(e => { const err = ge.launch.querySelector('.gerr'); err.textContent = e.message; err.hidden = false; });
  }

  /** Swap the launcher's rows for a file-name prompt. */
  function askMarkdownName(g) {
    const ge = groupEls.get(g.id);
    if (!ge) return;
    ge.lnaming = true;
    ge.launch.querySelector('.lq').value = '';
    renderLaunch(g);
    ge.launch.querySelector('.lq').focus();
  }
  function newMarkdown() {
    const g = newTab();
    if (g) askMarkdownName(g);
  }

  /** Open an existing file in place of the launcher. */
  async function openFromLauncher(g, r) {
    const launcher = g.active, lay = cur();
    if (lay && leafById(lay, g.id)) lay.lastFile = g.id;
    await E().openFileResult(r);
    if (launcher && launcher.startsWith('n:')) removeKey(launcher);
  }

  /** Create `name` (.md unless it has an extension) in the worktree root, open it in place of the launcher. An existing file is just opened. */
  async function createMarkdown(g, raw) {
    let name = raw.trim();
    if (!name || !root) return;
    const ge = groupEls.get(g.id), err = ge.launch.querySelector('.gerr');
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (/[\/\\]/.test(name)) return fail('Use a file name, not a path');
    if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.md';
    const file = `${root}/${name}`, launcher = g.active;
    try {
      const exists = await H.read(file).then(() => true, () => false);
      if (!exists) await H.write(file, '');
    } catch (e) { return fail(e.message); }
    const lay = cur();
    if (lay && leafById(lay, g.id)) lay.lastFile = g.id;
    await E().openFile(file, { pin: true });
    if (launcher && launcher.startsWith('n:')) removeKey(launcher);
  }

  /** Activate the previous/next tab of the focused group, wrapping around. */
  function cycleTab(dir) {
    const lay = cur();
    const g = lay && leafById(lay, lay.focus);
    if (!g || g.tabs.length < 2) return;
    const i = g.tabs.indexOf(g.active);
    activate(g, g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
  }

  /** Move the focused group's active tab to the neighbouring group (dir -1/+1, or 'up'/'down' by position), splitting off a new one at the end. */
  function moveActive(dir) {
    const lay = cur();
    const src = lay && leafById(lay, lay.focus);
    const key = src && src.active;
    if (!key) return;
    if (dir === 'up' || dir === 'down') {
      const rect = g => groupEls.get(g.id).el.getBoundingClientRect();
      const r = rect(src);
      const near = [...leaves(lay.tree)]
        .filter(g => g !== src && groupEls.has(g.id))
        .map(g => ({ g, b: rect(g) }))
        .filter(({ b }) => (dir === 'up' ? b.bottom <= r.top + 1 : b.top >= r.bottom - 1) && b.left < r.right && b.right > r.left)
        .sort((a, b) => (dir === 'up' ? b.b.bottom - a.b.bottom : a.b.top - b.b.top));
      if (near.length) moveTab(key, { kind: 'center', g: near[0].g });
      else if (src.tabs.length > 1) moveTab(key, { kind: 'edge', g: src, side: dir === 'up' ? 'top' : 'bottom' });
      return;
    }
    const all = [...leaves(lay.tree)];
    const tgt = all[all.indexOf(src) + dir];
    if (tgt) moveTab(key, { kind: 'center', g: tgt });
    else if (src.tabs.length > 1) moveTab(key, { kind: 'edge', g: src, side: dir < 0 ? 'left' : 'right' });
  }

  window.harborLayout = {
    init, setRoot, sync, renderTabs, agentLabel, openFile, removeFile, revealAgent, currentAgent, visibleAgents, activeFile, focusEditor,
    hasFile, hasKey, filesOf, diffKeys, forgetRoot, dragFile, openDiff, removeKey, activeKey,
    moveActive, cycleTab, toggleZoom, pickPane, splitFocused,
    newTab, newMarkdown,
    newPage, closePage: () => { const ws = root && workspaces.get(root); if (ws) closePage(ws.at); },
    renamePage: () => { const ws = root && workspaces.get(root); if (ws) renamePage(ws.at); },
    cyclePage, setPage,
    pages: () => { const ws = root && workspaces.get(root); return ws ? ws.pages.map((p, i) => ({ i, label: pageLabel(p, i) })) : []; },
    focusGroup: setFocus,
    focusedGroup: () => { const lay = cur(); return lay ? lay.focus : null; },
    expectAgent: id => {
      expectGroup = id;
      const lay = cur(), g = id && lay && leafById(lay, id);
      expectReplace = g && g.active && g.active.startsWith('n:') ? g.active : null;
    },
    closeActive() {
      const k = activeKey();
      if (k) closeKey(k);
      else closeEmptyPane();
    },
  };
})();
