'use strict';
/* global monaco */
// Tawny debugger UI: gutter breakpoints, the stopped-line marker, hover values, and a bottom panel
// (call stack, variables, debug console) driven by the Debug Adapter Protocol host in src/main/dap.js.
(() => {
  const H = window.harbor;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const base = p => p.split('/').pop();
  const E = () => window.harborEditor;
  const Lay = () => window.harborLayout;
  const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

  // ------------------------------------------------------------------ breakpoints
  // Decorations on the Monaco model are the truth while a model exists (they follow edits); `saved` holds the rest.

  const saved = new Map();     // path -> [{ line, condition?, logMessage? }] for files without a model
  const live = new Map();      // path -> Map(decoration id -> { condition?, logMessage?, verified? })
  let persistTimer = null;

  const modelOf = path => (window.monaco ? monaco.editor.getModel(monaco.Uri.file(path)) : null);

  function bpOptions(meta) {
    const kind = meta.logMessage ? 'log' : meta.condition ? 'cond' : 'bp';
    const tip = meta.logMessage ? `Logpoint: ${meta.logMessage}` : meta.condition ? `Breakpoint when: ${meta.condition}` : 'Breakpoint';
    return {
      glyphMarginClassName: `dbg-${kind}${meta.verified === false ? ' dbg-unverified' : ''}`,
      glyphMarginHoverMessage: { value: meta.verified === false ? `${tip} (not bound)` : tip },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    };
  }
  const bpRange = line => new monaco.Range(line, 1, line, 1);

  function modelCreated(path, model) {
    const list = saved.get(path);
    saved.delete(path);
    const m = new Map();
    live.set(path, m);
    if (!list) return;
    const ids = model.deltaDecorations([], list.map(b => ({ range: bpRange(Math.min(b.line, model.getLineCount())), options: bpOptions(b) })));
    ids.forEach((id, i) => m.set(id, { condition: list[i].condition, logMessage: list[i].logMessage }));
  }

  /** Current breakpoints of a file as [{ line, condition?, logMessage?, id? }], sorted by line, one per line. */
  function listFor(path) {
    const m = live.get(path), model = modelOf(path);
    if (!m || !model) return (saved.get(path) || []).map(b => ({ ...b }));
    const byLine = new Map();
    for (const [id, meta] of m) {
      const r = model.getDecorationRange(id);
      if (r) byLine.set(r.startLineNumber, { line: r.startLineNumber, condition: meta.condition, logMessage: meta.logMessage, id });
    }
    return [...byLine.values()].sort((a, b) => a.line - b.line);
  }

  const allPaths = () => new Set([...saved.keys(), ...live.keys()]);
  function allBreakpoints() {
    const out = {};
    for (const p of allPaths()) {
      const l = listFor(p).map(({ line, condition, logMessage }) => ({ line, condition, logMessage }));
      if (l.length) out[p] = l;
    }
    return out;
  }

  function setList(path, list) {
    const model = modelOf(path);
    if (!model || !live.has(path)) { list.length ? saved.set(path, list) : saved.delete(path); return; }
    const m = live.get(path);
    model.deltaDecorations([...m.keys()], []);
    m.clear();
    const ids = model.deltaDecorations([], list.map(b => ({ range: bpRange(b.line), options: bpOptions(b) })));
    ids.forEach((id, i) => m.set(id, { condition: list[i].condition, logMessage: list[i].logMessage }));
  }

  function changed(path) {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => H.saveUi({ breakpoints: allBreakpoints() }), 300);
    if (path) syncFile(path);
    renderBar();
  }

  async function syncFile(path) {
    if (!sess || sess.state === 'ended') return;
    const list = listFor(path);
    try { applyResults(path, list, await H.dapBreakpoints(sess.sid, path, list)); } catch { /* session ended */ }
  }

  /** Adapter verdicts (one per breakpoint, in request order) → hollow markers for the ones it couldn't bind. */
  function applyResults(path, list, results) {
    const m = live.get(path), model = modelOf(path);
    if (!m || !model || !results) return;
    list.forEach((b, i) => {
      const r = results[i], meta = b.id && m.get(b.id);
      if (!r || !meta) return;
      if (r.id !== undefined) (sess.bpIds ||= new Map()).set(r.id, { path, id: b.id });
      const verified = r.verified !== false;
      if (meta.verified === verified || (meta.verified === undefined && verified)) return;
      meta.verified = verified;
      model.deltaDecorations([b.id], [{ range: bpRange(model.getDecorationRange(b.id).startLineNumber), options: bpOptions(meta) }]);
    });
  }

  function toggleBreakpoint(path, line) {
    if (!path || !line) return;
    const list = listFor(path);
    const at = list.findIndex(b => b.line === line);
    if (at >= 0) list.splice(at, 1); else list.push({ line });
    setList(path, list);
    changed(path);
  }

  /** Add or edit a conditional breakpoint / logpoint on `line` (empty text turns it back into a plain breakpoint). */
  async function editBreakpoint(path, line, field) {
    const list = listFor(path);
    const cur = list.find(b => b.line === line) || { line };
    const text = await ask(field === 'logMessage' ? 'Log message (use {expr} to interpolate)…' : 'Break when expression is true…', cur[field] || '');
    if (text === null) return;
    const next = { line, [field]: text.trim() || undefined };
    const rest = list.filter(b => b.line !== line);
    setList(path, [...rest, next].sort((a, b) => a.line - b.line));
    changed(path);
  }

  function removeAll() {
    for (const p of allPaths()) setList(p, []);
    saved.clear();
    for (const p of live.keys()) if (sess && sess.state !== 'ended') syncFile(p);
    changed(null);
  }

  // ------------------------------------------------------------------ tiny prompt

  let askEl = null;
  function ask(placeholder, initial) {
    if (!askEl) {
      askEl = document.createElement('div');
      askEl.id = 'dbgPromptBack';
      askEl.hidden = true;
      askEl.innerHTML = '<div class="quick"><input id="dbgPromptInput" spellcheck="false"></div>';
      document.body.append(askEl);
    }
    const input = askEl.querySelector('input');
    return new Promise(resolve => {
      const prev = document.activeElement;
      const done = v => {
        askEl.hidden = true;
        input.onkeydown = null; askEl.onmousedown = null;
        if (prev && prev.isConnected) prev.focus();
        resolve(v);
      };
      input.placeholder = placeholder; input.value = initial || '';
      askEl.hidden = false;
      input.focus(); input.select();
      input.onkeydown = e => {
        if (e.key === 'Enter') { e.preventDefault(); done(input.value); }
        else if (e.key === 'Escape') { e.preventDefault(); done(null); }
        e.stopPropagation();
      };
      askEl.onmousedown = e => { if (e.target === askEl) done(null); };
    });
  }

  // ------------------------------------------------------------------ editor hooks

  function attach(ed) {
    ed.onMouseDown(e => {
      if (e.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN || !e.event.leftButton || !ed.getModel()) return;
      toggleBreakpoint(ed.getModel().uri.path, e.target.position.lineNumber);
    });
    const at = () => ({ path: ed.getModel() && ed.getModel().uri.path, line: ed.getPosition() && ed.getPosition().lineNumber });
    ed.addAction({ id: 'harbor.debug.toggle', label: 'Toggle Breakpoint', contextMenuGroupId: '8_debug', contextMenuOrder: 1, run: () => { const { path, line } = at(); toggleBreakpoint(path, line); } });
    ed.addAction({ id: 'harbor.debug.cond', label: 'Add Conditional Breakpoint…', contextMenuGroupId: '8_debug', contextMenuOrder: 2, run: () => { const { path, line } = at(); path && editBreakpoint(path, line, 'condition'); } });
    ed.addAction({ id: 'harbor.debug.log', label: 'Add Logpoint…', contextMenuGroupId: '8_debug', contextMenuOrder: 3, run: () => { const { path, line } = at(); path && editBreakpoint(path, line, 'logMessage'); } });
  }

  /** F5/F9/F10/F11 are claimed by Monaco in some contexts and by nothing in others; take them globally. */
  window.addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const idle = !sess || sess.state === 'ended';
    let handled = true;
    switch (e.key) {
      case 'F5': e.shiftKey ? stop() : idle ? start() : cont(); break;
      case 'F9': toggleAtCursor(); break;
      case 'F10': step('next'); break;
      case 'F11': step(e.shiftKey ? 'stepOut' : 'stepIn'); break;
      default: handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  function toggleAtCursor() {
    const ed = E().editor;
    if (!ed || !ed.getModel() || !ed.getPosition()) return;
    toggleBreakpoint(ed.getModel().uri.path, ed.getPosition().lineNumber);
  }

  // ------------------------------------------------------------------ session

  let sess = null;             // { sid, name, root, state: starting | running | stopped | ended, focus, frames, frameId, snapshot }
  let early = [];              // events that arrive before dapStart resolves
  let configs = [];
  let uiState = {};
  let chosen = null;           // selected config name
  const openVars = new Set();  // expanded variable paths, kept across steps

  async function start() {
    if (sess && sess.state !== 'ended') return;
    const root = E().root;
    if (!root) return;
    early = [];
    showPanel(true);
    const file = Lay().activeFile();
    await loadConfigs();
    const cfg = configs.find(c => c.name === chosen) || configs[0];
    if (!cfg) { out('No launch configuration. Open a .js or .rb file, or add one to .vscode/launch.json.', 'err'); return; }
    clearConsole();
    sess = { sid: null, name: cfg.name, root, state: 'starting', focus: null, frames: [], frameId: null, snapshot: allBreakpoints(), threads: new Map() };
    renderBar();
    try {
      const r = await H.dapStart(root, cfg, { file }, sess.snapshot);
      sess.sid = r.sid;
      const queued = early; early = [];
      for (const ev of queued) if (ev.sid === r.sid) onEvent(ev);
    } catch (e) {
      out(`Failed to start: ${e.message}`, 'err');
      sess.state = 'ended'; renderBar();
    }
  }

  function stop() {
    if (!sess || sess.state === 'ended') return;
    if (sess.sid !== null) H.dapStop(sess.sid).catch(() => {});
  }

  const dap = (command, args, cid) => H.dapRequest(sess.sid, cid ?? (sess.focus && sess.focus.cid) ?? 0, command, args);

  async function cont() {
    if (!sess || sess.state !== 'stopped' || !sess.focus) return;
    markRunning();
    try { await dap('continue', { threadId: sess.focus.threadId }); } catch { /* ended */ }
  }
  async function step(kind) {
    if (!sess || sess.state !== 'stopped' || !sess.focus) return;
    markRunning();
    try { await dap(kind, { threadId: sess.focus.threadId }); } catch { /* ended */ }
  }
  async function pause() {
    if (!sess || sess.state !== 'running') return;
    const cid = [...sess.threads.keys()][0];
    const tid = cid !== undefined ? [...sess.threads.get(cid)][0] : 1;
    try { await dap('pause', { threadId: tid ?? 1 }, cid); } catch (e) { out(`Pause failed: ${e.message}`, 'err'); }
  }

  function markRunning() {
    sess.state = 'running';
    clearLine();
    sess.frames = []; sess.frameId = null;
    renderBar(); renderStack(); renderVars();
  }

  H.onDapEvent(ev => {
    if (!sess || sess.sid === null) { early.push(ev); return; }
    if (ev.sid !== sess.sid) return;
    onEvent(ev);
  });

  function onEvent({ cid, event, body }) {
    body = body || {};
    switch (event) {
      case 'harbor:started':
        if (body.root && sess.state === 'starting') sess.state = 'running';
        renderBar(); break;
      case 'harbor:breakpoints':
        for (const [path, results] of Object.entries(body.results || {})) {
          const snap = sess.snapshot[path], cur = listFor(path);
          if (snap && snap.length === cur.length && snap.every((b, i) => b.line === cur[i].line)) applyResults(path, cur, results);
        }
        break;
      case 'harbor:error': out(body.message, 'err'); toast(`Debugger: ${body.message}`); break;
      case 'harbor:ended': endSession(); break;
      case 'harbor:connClosed': sess.threads.delete(cid); break;
      case 'thread': {
        const set = sess.threads.get(cid) || new Set();
        body.reason === 'exited' ? set.delete(body.threadId) : set.add(body.threadId);
        sess.threads.set(cid, set); break;
      }
      case 'stopped': onStopped(cid, body); break;
      case 'continued': if (sess.state === 'stopped' && sess.focus && sess.focus.cid === cid) markRunning(); break;
      case 'output': {
        if (body.category === 'telemetry') break;
        let text = String(body.output || '').replace(ANSI, '');
        if (cid === 0 && /^DEBUGGER: /.test(text)) break;   // rdbg's own banner
        out(text, body.category === 'stderr' ? 'err' : body.category === 'console' ? 'dim' : '');
        break;
      }
      case 'breakpoint': {
        const hit = body.breakpoint && sess.bpIds && sess.bpIds.get(body.breakpoint.id);
        const m = hit && live.get(hit.path), meta = m && m.get(hit.id), model = hit && modelOf(hit.path);
        if (meta && model && meta.verified !== (body.breakpoint.verified !== false)) {
          meta.verified = body.breakpoint.verified !== false;
          const r = model.getDecorationRange(hit.id);
          if (r) model.deltaDecorations([hit.id], [{ range: bpRange(r.startLineNumber), options: bpOptions(meta) }]);
        }
        break;
      }
      default:
    }
  }

  function endSession() {
    if (!sess) return;
    sess.state = 'ended';
    clearLine();
    sess.frames = []; sess.frameId = null;
    out(`— ${sess.name} ended —`, 'dim');
    renderBar(); renderStack(); renderVars();
  }

  async function onStopped(cid, body) {
    const threadId = body.threadId ?? 1;
    sess.state = 'stopped';
    sess.focus = { cid, threadId };
    sess.reason = body.reason;
    renderBar();
    showPanel(true);
    try {
      const r = await dap('stackTrace', { threadId, levels: 60 }, cid);
      if (!sess || sess.state !== 'stopped' || sess.focus.threadId !== threadId || sess.focus.cid !== cid) return;
      sess.frames = r.stackFrames || [];
      renderStack();
      let first = sess.frames.findIndex(f => f.source && f.source.path && f.presentationHint !== 'subtle' && f.presentationHint !== 'label');
      if (first < 0) first = sess.frames.findIndex(f => f.source && f.source.path);
      await selectFrame(Math.max(0, first));
    } catch (e) { out(`Stack trace failed: ${e.message}`, 'err'); }
  }

  async function selectFrame(i) {
    const f = sess.frames[i];
    if (!f) return;
    sess.frameId = f.id; sess.frameIdx = i;
    renderStack();
    const path = f.source && f.source.path;
    if (path && f.line) {
      await E().openFile(path, { selection: { lineNumber: f.line, column: f.column || 1 }, recordHistory: false, focus: false });
      markLine(path, f.line);
    } else clearLine();
    await loadScopes(f);
  }

  // ------------------------------------------------------------------ stopped line + hover

  let curLine = null;          // { model, ids }
  function markLine(path, line) {
    clearLine();
    const model = modelOf(path);
    if (!model) return;
    const ids = model.deltaDecorations([], [{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'dbg-line', glyphMarginClassName: 'dbg-arrow' },
    }]);
    curLine = { model, ids };
  }
  function clearLine() {
    if (curLine && !curLine.model.isDisposed()) curLine.model.deltaDecorations(curLine.ids, []);
    curLine = null;
  }

  /** The expression under the cursor: the dotted/:: chain up to and including the hovered identifier. */
  function expressionAt(model, pos) {
    const text = model.getLineContent(pos.lineNumber);
    const re = /[A-Za-z_$@][\w$]*(?:(?:\?\.|&\.|\.|::)[A-Za-z_$][\w$]*[?!]?)*/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (pos.column - 1 < s || pos.column - 1 > e) continue;
      const w = model.getWordAtPosition(pos);
      if (!w) return null;
      const upto = text.slice(s, w.endColumn - 1);
      return { expr: upto, range: new monaco.Range(pos.lineNumber, s + 1, pos.lineNumber, w.endColumn) };
    }
    return null;
  }

  function registerHover() {
    monaco.languages.registerHoverProvider(['javascript', 'typescript', 'ruby'], {
      async provideHover(model, pos) {
        if (!sess || sess.state !== 'stopped' || sess.frameId == null) return null;
        const sel = E().editor && E().editor.getSelection();
        const inSel = sel && !sel.isEmpty() && sel.containsPosition(pos) && sel.startLineNumber === sel.endLineNumber;
        const target = inSel ? { expr: model.getValueInRange(sel), range: sel } : expressionAt(model, pos);
        if (!target) return null;
        try {
          const r = await dap('evaluate', { expression: target.expr, frameId: sess.frameId, context: 'hover' });
          if (r.result === undefined || r.result === '') return null;
          return { range: target.range, contents: [{ value: '```text\n' + `${target.expr} = ${String(r.result).slice(0, 1000)}` + '\n```' }] };
        } catch { return null; }
      },
    });
  }

  // ------------------------------------------------------------------ panel

  let panel = null, consoleEl = null, openLine = null;

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'dbgPane';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="dbg-grip"></div>
      <div class="dbg-bar">
        <select id="dbgConfig" title="Launch configuration"></select>
        <span class="dbg-btns"></span>
        <span class="dbg-state"></span>
        <span class="dbg-sp"></span>
        <button class="icon-btn" data-a="clear" title="Clear console"><svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg></button>
        <button class="icon-btn" data-a="close" title="Close panel"><svg viewBox="0 0 16 16" width="11" height="11"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
      </div>
      <div class="dbg-body">
        <div class="dbg-side">
          <div class="dbg-sec"><div class="dbg-h">Call stack</div><div class="dbg-stack"></div></div>
          <div class="dbg-sec"><div class="dbg-h">Variables</div><div class="dbg-vars"></div></div>
        </div>
        <div class="dbg-grip-v"></div>
        <div class="dbg-main">
          <div class="dbg-out"></div>
          <div class="dbg-in"><span>›</span><input placeholder="Evaluate in the selected frame…" spellcheck="false"></div>
        </div>
      </div>`;
    const ws = $('#workspace');
    ws.insertBefore(panel, $('#edStatus'));
    consoleEl = panel.querySelector('.dbg-out');
    if (uiState.dbgHeight) panel.style.height = uiState.dbgHeight;

    panel.querySelector('.dbg-grip').addEventListener('mousedown', e => {
      e.preventDefault();
      const sy = e.clientY, sh = panel.getBoundingClientRect().height;
      const mv = ev => { panel.style.height = `${Math.max(120, Math.min(window.innerHeight - 200, sh + sy - ev.clientY))}px`; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); H.saveUi({ dbgHeight: panel.style.height }); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
    panel.querySelector('[data-a=close]').onclick = () => showPanel(false);
    panel.querySelector('[data-a=clear]').onclick = clearConsole;
    panel.querySelector('#dbgConfig').addEventListener('change', e => { chosen = e.target.value; });
    panel.querySelector('#dbgConfig').addEventListener('mousedown', loadConfigs);
    panel.querySelector('.dbg-btns').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      ({ start, cont, pause, stop, next: () => step('next'), in: () => step('stepIn'), out: () => step('stepOut') })[b.dataset.a]();
    });
    panel.querySelector('.dbg-stack').addEventListener('click', e => {
      const row = e.target.closest('.dbg-fr');
      if (row && sess) selectFrame(Number(row.dataset.i));
    });
    panel.querySelector('.dbg-vars').addEventListener('click', onVarClick);
    const input = panel.querySelector('.dbg-in input');
    const hist = []; let hi = 0;
    input.addEventListener('keydown', async e => {
      e.stopPropagation();
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        hi = Math.max(0, Math.min(hist.length, hi + (e.key === 'ArrowUp' ? -1 : 1)));
        input.value = hist[hi] || '';
        e.preventDefault();
      } else if (e.key === 'Enter' && input.value.trim()) {
        const expr = input.value.trim();
        hist.push(expr); hi = hist.length; input.value = '';
        out(`› ${expr}`, 'in');
        if (!sess || sess.state !== 'stopped') { out('Not paused — expressions are evaluated at a breakpoint.', 'dim'); return; }
        try {
          const r = await dap('evaluate', { expression: expr, frameId: sess.frameId, context: 'repl' });
          out(String(r.result ?? ''), 'res');
          if (sess.state === 'stopped') loadScopes(sess.frames[sess.frameIdx]);   // evaluation may have changed state
        } catch (err) { out(err.message, 'err'); }
      }
    });
    renderBar();
  }

  function showPanel(on) {
    if (!panel) { if (!on) return; buildPanel(); }
    panel.hidden = !on;
    if (on) loadConfigs();
  }

  async function loadConfigs() {
    const root = E().root;
    if (!root || !panel) return;
    try { configs = await H.dapConfigs(root, Lay().activeFile()); } catch { configs = []; }
    if (!configs.some(c => c.name === chosen)) chosen = (configs[0] || {}).name || null;
    const sel = panel.querySelector('#dbgConfig');
    sel.innerHTML = configs.length ? configs.map(c => `<option ${c.name === chosen ? 'selected' : ''}>${esc(c.name)}</option>`).join('') : '<option>No configuration</option>';
    sel.disabled = !configs.length;
    renderBar();
  }

  const BTN = {
    start: ['▶', 'Start debugging (F5)', 'start'],
    cont: ['▶', 'Continue (F5)', 'cont'],
    pause: ['⏸', 'Pause', 'pause'],
    next: ['<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9.5a5.5 5.5 0 0 1 11 0"/><path d="M11 7.5l2.5 2-2.5 2"/><circle cx="8" cy="12.5" r="1" fill="currentColor"/></svg>', 'Step over (F10)', 'next'],
    in: ['<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M5 7.5L8 10.5l3-3"/><circle cx="8" cy="13" r="1" fill="currentColor"/></svg>', 'Step into (F11)', 'in'],
    out: ['<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2M5 4.5L8 1.5l3 3"/><circle cx="8" cy="13" r="1" fill="currentColor"/></svg>', 'Step out (⇧F11)', 'out'],
    stop: ['■', 'Stop (⇧F5)', 'stop'],
  };

  function renderBar() {
    if (!panel) return;
    const st = sess ? sess.state : 'ended';
    const idle = st === 'ended', stopped = st === 'stopped', running = st === 'running';
    const items = idle ? ['start'] : stopped ? ['cont', 'next', 'in', 'out', 'stop'] : running ? ['pause', 'stop'] : ['stop'];
    panel.querySelector('.dbg-btns').innerHTML = items.map(k => `<button class="dbg-b ${k === 'stop' ? 'stop' : k === 'start' || k === 'cont' ? 'go' : ''}" data-a="${BTN[k][2]}" title="${esc(BTN[k][1])}" ${k === 'start' && !configs.length ? 'disabled' : ''}>${BTN[k][0]}</button>`).join('');
    const label = !sess || idle ? '' : st === 'starting' ? 'Starting…' : running ? 'Running' : `Paused${sess.reason ? ` (${sess.reason})` : ''}`;
    panel.querySelector('.dbg-state').textContent = label;
    panel.querySelector('.dbg-state').className = `dbg-state ${st}`;
    panel.querySelector('#dbgConfig').disabled = !idle || !configs.length;
  }

  // ---- console

  function out(text, cls = '') {
    if (!panel) buildPanel();
    const parts = String(text).split('\n');
    const near = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      if (last && p === '' && i > 0) { openLine = null; return; }
      if (openLine && openLine.cls === cls) openLine.el.textContent += p;
      else {
        const el = document.createElement('div');
        el.className = `dbg-ln ${cls}`;
        el.textContent = p;
        consoleEl.append(el);
        openLine = { el, cls };
      }
      if (!last) openLine = null;
    });
    while (consoleEl.childElementCount > 3000) consoleEl.firstElementChild.remove();
    if (near) consoleEl.scrollTop = consoleEl.scrollHeight;
  }
  function clearConsole() { if (consoleEl) consoleEl.textContent = ''; openLine = null; }

  // ---- call stack

  function renderStack() {
    if (!panel) return;
    const el = panel.querySelector('.dbg-stack');
    if (!sess || sess.state !== 'stopped' || !sess.frames.length) {
      el.innerHTML = `<div class="dbg-none">${sess && sess.state === 'running' ? 'Running' : sess && sess.state === 'starting' ? 'Starting…' : 'Not paused'}</div>`;
      return;
    }
    el.innerHTML = sess.frames.map((f, i) => {
      if (f.presentationHint === 'label') return `<div class="dbg-lbl">${esc(f.name)}</div>`;
      const p = f.source && f.source.path;
      const where = p ? `${esc(base(p))}:${f.line}` : f.source ? esc(f.source.name || '') : '';
      return `<div class="dbg-fr ${i === sess.frameIdx ? 'sel' : ''} ${f.presentationHint === 'subtle' || !p ? 'dim' : ''}" data-i="${i}" title="${esc(p || '')}"><span class="n">${esc(f.name)}</span><span class="w">${where}</span></div>`;
    }).join('');
  }

  // ---- variables

  async function loadScopes(frame) {
    if (!frame || !sess) return;
    const el = panel.querySelector('.dbg-vars');
    const frameId = frame.id;
    try {
      const { scopes } = await dap('scopes', { frameId });
      if (!sess || sess.frameId !== frameId) return;
      el.textContent = '';
      for (const [i, s] of scopes.entries()) {
        const row = document.createElement('div');
        row.className = 'dbg-scope';
        row.dataset.ref = s.variablesReference;
        row.dataset.key = s.name;
        row.innerHTML = `<div class="dbg-v scope"><span class="tw">▸</span><span class="k">${esc(s.name)}</span></div><div class="kids" hidden></div>`;
        el.append(row);
        const key = s.name;
        if (i === 0 || openVars.has(key)) { openVars.add(key); await expand(row, s.variablesReference, key); }
      }
    } catch (e) { el.innerHTML = `<div class="dbg-none">${esc(e.message)}</div>`; }
  }

  function renderVars() {
    if (!panel || (sess && sess.state === 'stopped')) return;
    panel.querySelector('.dbg-vars').innerHTML = '<div class="dbg-none">—</div>';
  }

  async function expand(row, ref, key) {
    const kids = row.querySelector(':scope > .kids');
    const tw = row.querySelector(':scope > .dbg-v > .tw');
    tw.textContent = '▾';
    kids.hidden = false;
    kids.innerHTML = '<div class="dbg-none">…</div>';
    let vars;
    try { vars = (await dap('variables', { variablesReference: ref })).variables || []; }
    catch (e) { kids.innerHTML = `<div class="dbg-none">${esc(e.message)}</div>`; return; }
    kids.textContent = '';
    for (const v of vars) {
      const k = `${key}/${v.name}`;
      const el = document.createElement('div');
      el.className = 'dbg-var';
      el.dataset.ref = v.variablesReference || 0;
      el.dataset.key = k;
      const val = String(v.value ?? '');
      el.innerHTML = `<div class="dbg-v"><span class="tw">${v.variablesReference > 0 ? '▸' : ''}</span><span class="k">${esc(v.name)}</span><span class="sepr">:</span><span class="val" title="${esc(val.slice(0, 600))}">${esc(val.length > 240 ? `${val.slice(0, 240)}…` : val)}</span></div><div class="kids" hidden></div>`;
      kids.append(el);
      if (v.variablesReference > 0 && openVars.has(k)) await expand(el, v.variablesReference, k);
    }
    if (!vars.length) kids.innerHTML = '<div class="dbg-none">empty</div>';
  }

  function onVarClick(e) {
    const head = e.target.closest('.dbg-v');
    if (!head) return;
    const row = head.parentElement;
    const ref = Number(row.dataset.ref);
    if (!ref) return;
    const kids = row.querySelector(':scope > .kids');
    const key = row.dataset.key;
    if (!kids.hidden) {
      kids.hidden = true; head.querySelector('.tw').textContent = '▸'; openVars.delete(key);
    } else { openVars.add(key); expand(row, ref, key); }
  }

  // ------------------------------------------------------------------ init

  function toast(msg) { window.harborApp && window.harborApp.toast(msg); }

  function init(ui) {
    uiState = ui || {};
    for (const [path, list] of Object.entries((ui && ui.breakpoints) || {})) saved.set(path, list);
    registerHover();
  }

  window.harborDebug = {
    init, attach, modelCreated,
    saved: path => { if (live.has(path)) syncFile(path); },
    start, stop, cont, pause, step, toggleBreakpoint: toggleAtCursor, removeAll,
    togglePanel: () => showPanel(!(panel && !panel.hidden)),
    showPanel: () => showPanel(true),
    condBreakpoint: field => {
      const ed = E().editor;
      if (ed && ed.getModel() && ed.getPosition()) editBreakpoint(ed.getModel().uri.path, ed.getPosition().lineNumber, field);
    },
    get active() { return !!sess && sess.state !== 'ended'; },
  };
})();
