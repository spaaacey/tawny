// @ts-nocheck -- typing in progress

/* global monaco */
// Tawny editor: Monaco + language servers (via main process), tabs, file tree, ⌘P file search.
(() => {
  const H = window.harbor;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const sep = '/';
  const base = p => p.split(sep).pop();
  const dirname = p => p.slice(0, p.lastIndexOf(sep)) || sep;

  const Lay = () => window.harborLayout;
  const editors = new Map();       // group id -> monaco editor (one per tab group)
  const hosts = new Map();         // group id -> { host, pill } (the editor's container and its Source/Rich switch)
  const asks = new WeakMap();      // monaco editor -> { focus() } for its selection message box
  const richViews = new Map();     // group id -> { view (Tiptap, window.harborRich), path, text, syncing } while created
  const richOverride = new Map();  // markdown path -> true/false once toggled; otherwise settings.richMarkdown decides (default: rich)
  let editor = null;               // the editor of the focused group
  let root = null;                 // active worktree
  let settings = {};
  let lspStatus = [];
  const models = new Map();        // path -> meta
  const knownRoots = new Set();
  const diffs = new Map();         // group id -> { ed (diff editor), shown, key, mode, path, root, owned: [in-memory models] }
  const indexByRoot = new Map();   // root -> [rel]
  const pendingDiags = new Map();  // path -> lsp diagnostics
  const history = [];              // [{path, line, col}] for go back
  let historyPos = -1;
  let ready = false;
  const readyWaiters = [];

  // ------------------------------------------------------------------ helpers

  const LANG_BY_EXT = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ru: 'ruby', jbuilder: 'ruby', erb: 'html',
    json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown', yml: 'yaml', yaml: 'yaml',
    css: 'css', scss: 'scss', less: 'less', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql', py: 'python', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift', dart: 'dart', php: 'php', c: 'c', h: 'c', cpp: 'cpp',
    graphql: 'graphql', gql: 'graphql', dockerfile: 'dockerfile', ini: 'ini', toml: 'ini', env: 'ini',
  };
  const RUBY_NAMES = new Set(['Gemfile', 'Rakefile', 'Guardfile', 'Capfile', 'Brewfile', 'Podfile', 'Fastfile']);
  function languageFor(p) {
    const b = base(p);
    if (RUBY_NAMES.has(b)) return 'ruby';
    if (b === 'Dockerfile') return 'dockerfile';
    if (b.startsWith('.env')) return 'ini';
    const ext = b.includes('.') ? b.split('.').pop().toLowerCase() : '';
    return LANG_BY_EXT[ext] || 'plaintext';
  }

  function uriToPath(u) {
    try {
      const url = new URL(u);
      if (url.protocol !== 'file:') return null;
      return decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
    } catch { return null; }
  }
  const toLspPos = p => ({ line: p.lineNumber - 1, character: p.column - 1 });
  const toRange = r => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const toLspRange = r => ({ start: { line: r.startLineNumber - 1, character: r.startColumn - 1 }, end: { line: r.endLineNumber - 1, character: r.endColumn - 1 } });
  const metaOf = model => model && models.get(model.uri.path);
  const rel = p => (root && p.startsWith(root + sep) ? p.slice(root.length + 1) : p);

  function markdown(c) {
    if (!c) return [];
    if (Array.isArray(c)) return c.flatMap(markdown);
    if (typeof c === 'string') return c ? [{ value: c }] : [];
    if (c.kind === 'plaintext') return [{ value: '```text\n' + c.value + '\n```' }];
    if (c.kind === 'markdown') return [{ value: c.value, isTrusted: false, supportHtml: false }];
    if (c.language !== undefined) return [{ value: '```' + c.language + '\n' + c.value + '\n```' }];
    return [];
  }
  const docString = d => (!d ? undefined : typeof d === 'string' ? d : d.kind === 'markdown' ? { value: d.value } : d.value);

  async function req(model, method, params = {}) {
    const m = metaOf(model);
    if (!m || !m.kind || !m.lspOpen) return null;
    try { return await H.lspRequest(m.root, m.kind, method, { textDocument: { uri: m.uri }, ...params }); }
    catch { return null; }
  }

  // ------------------------------------------------------------------ models

  async function ensureModel(path, { lsp = false } = {}) {
    let m = models.get(path);
    if (!m) {
      const file = await H.read(path);
      const model = file.binary ? null : monaco.editor.createModel(file.text, languageFor(path), monaco.Uri.file(path));
      m = {
        path, model, root: rootFor(path), binary: file.binary, mtime: file.mtime, savedAlt: model ? model.getAlternativeVersionId() : 0,
        kind: null, uri: null, version: 1, syncKind: 2, lspOpen: false, conflict: false, viewState: null, diags: [],
      };
      models.set(path, m);
      if (model) {
        window.harborDebug.modelCreated(path, model);
        model.onDidChangeContent(e => onModelChange(m, e));
        const pd = pendingDiags.get(path);
        if (pd) { setDiagnostics(m, pd); pendingDiags.delete(path); }
      }
    }
    if (lsp && m.model && !m.lspOpen && !m.lspPending) await openLsp(m);
    return m;
  }

  function rootFor(p) {
    if (root && (p === root || p.startsWith(root + sep))) return root;
    for (const r of knownRoots) if (p.startsWith(r + sep)) return r;
    return root;
  }

  async function openLsp(m) {
    m.lspPending = true;
    try {
      const res = await H.lspOpen(m.root, m.path, m.model.getValue());
      if (res && !res.error) {
        Object.assign(m, { kind: res.kind, uri: res.uri, syncKind: res.syncKind, version: 1, lspOpen: true });
      } else if (res && res.error) {
        m.kind = res.kind; m.lspOpen = false; m.lspError = res.error;
      }
    } catch (e) { m.lspError = e.message; }
    finally { m.lspPending = false; renderStatus(); }
  }

  let applyingDisk = false;
  function onModelChange(m, e) {
    for (const rv of richViews.values()) {
      if (rv.path === m.path && !rv.syncing) { rv.text = m.model.getValue(); rv.view.setMarkdown(rv.text); }
    }
    if (m.lspOpen) {
      m.version++;
      const changes = m.syncKind === 2
        ? e.changes.map(c => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }))
        : [{ text: m.model.getValue() }];
      H.lspChange(m.root, m.kind, m.uri, m.version, changes);
    }
    // models without a tab (e.g. touched by a rename across files) are saved straight away
    if (!applyingDisk && !isOpenInTab(m.path)) { clearTimeout(m.bgSave); m.bgSave = setTimeout(() => save(m.path), 50); }
    renderTabs();
  }

  const isDirty = m => m && m.model && m.model.getAlternativeVersionId() !== m.savedAlt;
  const isOpenInTab = p => Lay().hasFile(p);

  async function save(path) {
    const m = models.get(path || Lay().activeFile() || (parseDiff(Lay().activeKey()) || {}).path);
    if (!m || !m.model) return;
    const text = m.model.getValue();
    try {
      m.mtime = await H.write(m.path, text);
      m.savedAlt = m.model.getAlternativeVersionId();
      m.conflict = false;
      if (m.lspOpen) H.lspSave(m.root, m.kind, m.uri, text);
      window.harborDebug.saved(m.path);
      renderTabs();
      refreshGit();
    } catch (e) { toast(`Save failed: ${e.message}`); }
  }

  /** File changed on disk (agent edits): reload clean buffers in place, flag dirty ones. */
  async function reloadFromDisk(path) {
    const m = models.get(path);
    if (!m || !m.model) return;
    let file;
    try { file = await H.read(path); } catch { return; } // deleted: keep buffer
    if (file.binary) return;
    const cur = m.model.getValue();
    if (file.text === cur) { m.mtime = file.mtime; return; }
    if (isDirty(m)) { m.conflict = true; renderTabs(); return; }
    applyingDisk = true;
    try {
      const shown = [...editors.values()].filter(ed => ed.getModel() === m.model);
      const states = shown.map(ed => ed.saveViewState());
      m.model.pushEditOperations([], [{ range: m.model.getFullModelRange(), text: file.text }], () => null);
      m.savedAlt = m.model.getAlternativeVersionId();
      m.mtime = file.mtime;
      shown.forEach((ed, i) => ed.restoreViewState(states[i]));
    } finally { applyingDisk = false; }
    renderTabs();
  }

  // ------------------------------------------------------------------ opening / tabs

  async function openFile(path, opts = {}) {
    await whenReady();
    if (opts.recordHistory !== false) pushHistory();
    const gid = await Lay().openFile(path, { focus: opts.focus !== false, preview: !!opts.preview, pin: !!opts.pin });
    if (!gid) return;
    const ed = editors.get(gid);
    const m = models.get(path);
    if (ed && m && m.model && opts.selection) {
      const s = opts.selection;
      const range = s.startLineNumber ? s : new monaco.Range(s.lineNumber, s.column, s.lineNumber, s.column);
      ed.setSelection(range);
      ed.revealRangeInCenterIfOutsideViewport(range, 0);
    }
    if (opts.focus !== false && ed) ed.focus();
    revealInTree(path);
  }

  /** Put `path` into the editor of group `gid` (creating the editor in `host` on first use). */
  const showTok = new Map();
  async function show(gid, host, path) {
    await whenReady();
    const tok = (showTok.get(gid) || 0) + 1;
    showTok.set(gid, tok);
    const dd = diffs.get(gid);
    if (dd && dd.shown) releaseDiff(dd);
    const ed = editors.get(gid) || createEditor(gid, host);
    if (Lay().focusedGroup() === gid) editor = ed;
    const prev = ed.getModel() && metaOf(ed.getModel());
    if (prev) prev.viewState = ed.saveViewState();
    let m;
    try { m = await ensureModel(path, { lsp: true }); }
    catch (e) { toast(`Can't open ${base(path)}: ${e.message}`); return { error: true }; }
    if (showTok.get(gid) !== tok) return m;
    if (m.model) {
      ed.setModel(m.model);
      if (m.viewState) ed.restoreViewState(m.viewState);
    } else ed.setModel(null);
    syncRich(gid, path);
    renderStatus();
    markTreeActive();
    return m;
  }

  // ------------------------------------------------------------------ rich markdown
  // A Tiptap view laid over the Monaco editor of the group. The Monaco model stays the source of truth (save, dirty,
  // disk reload and diffs all keep working): rich edits are written into it as markdown, model edits are pushed back.

  const isRichable = p => /\.(md|markdown)$/i.test(p);
  const wantsRich = p => (richOverride.has(p) ? richOverride.get(p) : settings.richMarkdown !== false);

  function syncRich(gid, path) {
    const h = hosts.get(gid);
    if (!h) return;
    const m = path && models.get(path);
    const able = !!(m && m.model && isRichable(path));
    const on = able && wantsRich(path);
    h.pill.hidden = !able;
    h.pill.querySelector('[data-m=rich]').classList.toggle('on', on);
    h.pill.querySelector('[data-m=source]').classList.toggle('on', !on);
    let rv = richViews.get(gid);
    if (!on) {
      if (rv) { rv.view.el.hidden = true; rv.path = null; }
      return;
    }
    if (!rv) {
      rv = { path: null, text: null, syncing: false };
      rv.view = window.harborRich.create(h.host, {
        onChange: md => {
          const mm = models.get(rv.path);
          if (!mm || !mm.model) return;
          rv.syncing = true;
          try { mm.model.pushEditOperations([], [{ range: mm.model.getFullModelRange(), text: md }], () => null); } finally { rv.syncing = false; }
          rv.text = mm.model.getValue();
        },
        onLink: href => {
          if (/^https?:/i.test(href)) { window.open(href); return; }
          if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
          const target = decodeURIComponent(new URL(href, 'file://' + dirname(rv.path) + '/').pathname);
          if (target !== rv.path) openFile(target);
        },
        onSelectionMenu: (x, y) => showContextMenu(x, y, [
          { label: 'Send Selection to Agent', run: () => sendSelectionToAgent() },
          { label: 'Copy', run: () => document.execCommand('copy') },
        ]),
        ask: {
          targets: () => window.harborApp.sendTargets(),
          send: (msg, id) => { const ref = selectionRef(); if (ref) window.harborApp.askAgent(ref, msg, id); },
        },
        keys: {
          'Mod-b': () => window.harborApp.toggleSidebar(),
          'Mod-Alt-l': () => sendSelectionToAgent(),
          'Mod-Alt-Shift-ArrowLeft': () => Lay().moveActive(-1), 'Mod-Alt-Shift-ArrowRight': () => Lay().moveActive(1),
          'Mod-Alt-Shift-ArrowUp': () => Lay().moveActive('up'), 'Mod-Alt-Shift-ArrowDown': () => Lay().moveActive('down'),
        },
      });
      rv.view.el.addEventListener('focusin', () => { editor = editors.get(gid) || editor; Lay().focusGroup(gid); });
      richViews.set(gid, rv);
    }
    const text = m.model.getValue();
    rv.view.setBaseDir(dirname(path));
    if (rv.path !== path || rv.text !== text) { rv.view.setMarkdown(text, { reset: rv.path !== path }); rv.text = text; }
    rv.path = path;
    rv.view.el.hidden = false;
  }

  function setRich(path, on) {
    richOverride.set(path, on);
    for (const [gid, ed] of editors) {
      const mm = ed.getModel() && metaOf(ed.getModel());
      if (mm && mm.path === path) syncRich(gid, path);
    }
    const gid = Lay().focusedGroup();
    if (gid) focusGroup(gid);
  }

  function toggleRich() {
    const p = Lay().activeFile();
    if (!p || !isRichable(p)) { toast('Rich view is for markdown files'); return; }
    setRich(p, !wantsRich(p));
  }

  /** Ensure models (and language servers) exist for restored tabs; resolves with the paths that are gone. */
  async function preload(paths) {
    await whenReady();
    const missing = [];
    for (const p of paths) { try { await ensureModel(p, { lsp: true }); } catch { missing.push(p); } }
    return missing;
  }

  async function closeTab(path) {
    path = path || Lay().activeFile();
    if (!path) return;
    const m = models.get(path);
    if (isDirty(m) && !confirm(`${base(path)} has unsaved changes. Close anyway?`)) return;
    Lay().removeFile(path);
    // drop the model once no worktree has it open
    if (m && !isOpenInTab(path)) {
      freeModel(m, path);
    }
  }

  /** Free the model of a tab replaced in place, unless it is open elsewhere. */
  function dropPath(path) {
    const m = models.get(path);
    if (m && !isOpenInTab(path)) freeModel(m, path);
  }

  function freeModel(m, path) {
    if (m.lspOpen) H.lspClose(m.root, m.kind, m.uri);
    if (m.model) { releaseDiffsUsing(m.model); m.model.dispose(); }
    richOverride.delete(path);
    for (const rv of richViews.values()) if (rv.path === path) { rv.view.el.hidden = true; rv.path = null; }
    models.delete(path);
  }

  const renderTabs = () => Lay().renderTabs();

  function tabInfo(path) {
    const m = models.get(path);
    return {
      name: base(path), title: rel(path), dirty: !!isDirty(m), conflict: !!(m && m.conflict),
      errs: m ? m.diags.filter(d => d.severity === 1).length : 0,
    };
  }

  function saveView(gid, path) {
    const ed = editors.get(gid), m = models.get(path);
    if (ed && m && m.model && ed.getModel() === m.model) m.viewState = ed.saveViewState();
  }

  function focusGroup(gid) {
    let tries = 0;
    const go = () => {
      const rv = richViews.get(gid);
      if (rv && rv.path) { rv.view.focus(); return; }
      const dd = diffs.get(gid);
      const ed = dd && dd.shown ? dd.ed.getModifiedEditor() : editors.get(gid);
      if (ed && ed.getModel()) ed.focus(); else if (tries++ < 20) setTimeout(go, 50);
    };
    go();
  }

  function groupFocused(gid) {
    const dd = diffs.get(gid);
    const ed = dd && dd.shown ? dd.ed.getModifiedEditor() : editors.get(gid);
    if (ed) editor = ed;
    renderStatus();
    markTreeActive();
  }

  function disposeGroup(gid) {
    const dd = diffs.get(gid);
    if (dd) {
      const mod = dd.ed.getModifiedEditor();
      releaseDiff(dd);
      if (editor === mod) editor = null;
      dd.ed.dispose();
      diffs.delete(gid);
    }
    const rv = richViews.get(gid);
    if (rv) { rv.view.destroy(); richViews.delete(gid); }
    hosts.delete(gid);
    const ed = editors.get(gid);
    if (!ed) return;
    const m = ed.getModel() && metaOf(ed.getModel());
    if (m) m.viewState = ed.saveViewState();
    editors.delete(gid);
    showTok.delete(gid);
    if (editor === ed) editor = null;
    ed.dispose();
  }

  // ------------------------------------------------------------------ diff tabs
  // 'd:s:<path>' = staged (HEAD ↔ index, read-only), 'd:w:<path>' = unstaged (index ↔ working tree, editable),
  // 'd:c:<sha>:<path>' = a commit (parent ↔ commit, read-only), 'd:t:<n>:<path>' = texts held in memory (an agent's edit, read-only).
  const textDiffs = new Map();   // key -> { oldText, newText }; gone after a restart, which closes the tab
  let textDiffSeq = 0;

  function parseDiff(key) {
    const m = /^d:([swct]):(.*)$/.exec(key || '');
    if (!m) return null;
    if (m[1] === 't') {
      const t = /^(\d+):(.*)$/.exec(m[2]);
      return t ? { mode: 't', n: t[1], path: t[2] } : null;
    }
    if (m[1] !== 'c') return { mode: m[1], path: m[2] };
    const c = /^([0-9a-f]{7,40}):(.*)$/.exec(m[2]);
    return c ? { mode: 'c', sha: c[1], path: c[2] } : null;
  }
  const relIn = (r, p) => (p.startsWith(r + sep) ? p.slice(r.length + 1) : p);
  let gitUriSeq = 0;
  // never a file: URI, so metaOf() finds no language-server state for these models
  const gitUri = (ref, path) => monaco.Uri.from({ scheme: 'harbor-git', path: `/${ref}${path}`, query: String(++gitUriSeq) });

  function diffInfo(key) {
    const d = parseDiff(key);
    if (!d) return { name: key, title: key, dirty: false };
    if (d.mode === 'c') {
      const sh = d.sha.slice(0, 7);
      return { name: `${base(d.path)} (${sh})`, title: `${rel(d.path)} — ${sh}^ ↔ ${sh}`, dirty: false };
    }
    if (d.mode === 't') return { name: `${base(d.path)} (Agent edit)`, title: `${rel(d.path)} — before ↔ after`, dirty: false };
    const staged = d.mode === 's';
    return {
      name: `${base(d.path)} (${staged ? 'Index' : 'Working Tree'})`,
      title: `${rel(d.path)} — ${staged ? 'HEAD ↔ Index' : 'Index ↔ Working Tree'}`,
      dirty: !staged && !!isDirty(models.get(d.path)),
    };
  }

  /** Original/modified text from git for a diff tab ({ orig, mod } — mod only for staged and commit diffs). */
  async function diffSides(r, mode, path, sha) {
    const rl = relIn(r, path);
    if (mode === 'c') {
      const ch = (Tree().commitFiles(sha)).find(x => x.path === rl);
      const [orig, mod] = await Promise.all([H.gitShow(r, (ch && ch.orig) || rl, `${sha}^`), H.gitShow(r, rl, sha)]);
      return { orig, mod };
    }
    const c = Tree().changes(r);
    const ch = c && (mode === 's' ? c.staged : c.unstaged).find(x => x.path === rl);
    const orig = await H.gitShow(r, (ch && ch.orig) || rl, mode === 's' ? 'HEAD' : 'index');
    const mod = mode === 's' ? await H.gitShow(r, rl, 'index') : null;
    return { orig, mod };
  }

  function createDiff(gid, host) {
    const size = settings.editorFontSize || 13;
    const ed = monaco.editor.createDiffEditor(host, {
      theme: window.harborTheme.monaco().id, automaticLayout: true,
      fontFamily: settings.editorFontFamily || '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
      fontSize: size, lineHeight: Math.round(size * 1.6),
      renderSideBySide: true, renderSideBySideInlineBreakpoint: 700, originalEditable: false, ignoreTrimWhitespace: false, enableSplitViewResizing: true,
      minimap: { enabled: false }, scrollBeyondLastLine: false, smoothScrolling: true, padding: { top: 8 }, fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    const dd = { ed, inline: false, shown: false, key: null, mode: null, path: null, root: null, owned: [] };
    diffs.set(gid, dd);
    const mod = ed.getModifiedEditor();
    for (const side of [mod, ed.getOriginalEditor()]) {
      side.onDidFocusEditorWidget(() => { editor = mod; Lay().focusGroup(gid); });
      side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => window.harborApp.toggleSidebar());
      side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => window.harborApp.openPalette());
      addMoveTabKeys(side);
      side.addCommand(monaco.KeyCode.F7, () => ed.goToDiff('next'));
      side.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => ed.goToDiff('previous'));
    }
    // the diff goes inline on its own in narrow panes; this pins either layout
    mod.addAction({
      id: 'harbor.toggleInlineDiff', label: 'Toggle Inline View', contextMenuGroupId: '9_harbor', contextMenuOrder: 2,
      run: () => {
        dd.inline = !dd.inline;
        ed.updateOptions({ renderSideBySide: !dd.inline, useInlineViewWhenSpaceIsLimited: false });
      },
    });
    return dd;
  }

  /** Detach the models from a diff editor and free the ones we created for it. */
  function releaseDiff(dd) {
    dd.shown = false;
    dd.key = null;
    dd.ed.setModel(null);
    dd.owned.splice(0).forEach(m => m.dispose());
  }
  function releaseDiffsUsing(model) {
    for (const dd of diffs.values()) {
      const cur = dd.ed.getModel();
      if (cur && (cur.modified === model || cur.original === model)) releaseDiff(dd);
    }
  }

  async function showDiff(gid, host, key) {
    await whenReady();
    const tok = (showTok.get(gid) || 0) + 1;
    showTok.set(gid, tok);
    const d = parseDiff(key);
    if (!d) return { error: true };
    const r = rootFor(d.path);
    const dd = diffs.get(gid) || createDiff(gid, host);
    if (d.mode === 't') {
      const t = textDiffs.get(key);
      if (!t) return { error: true };
      const lang = languageFor(d.path);
      const original = monaco.editor.createModel(t.oldText, lang, gitUri('before', d.path));
      const modified = monaco.editor.createModel(t.newText, lang, gitUri('after', d.path));
      const old = dd.owned.splice(0);
      dd.ed.setModel({ original, modified });
      old.forEach(m => m.dispose());
      Object.assign(dd, { owned: [original, modified], shown: true, key, mode: 't', path: d.path, root: r });
      dd.ed.getModifiedEditor().updateOptions({ readOnly: true });
      if (Lay().focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
      renderStatus();
      return { model: true };
    }
    let sides, meta = null;
    try {
      sides = await diffSides(r, d.mode, d.path, d.sha);
      if (d.mode === 'w') { try { meta = await ensureModel(d.path); } catch { meta = null; } } // deleted files have no model
    } catch (e) { toast(`Can't diff ${base(d.path)}: ${e.message}`); return { error: true }; }
    if (showTok.get(gid) !== tok) return {};
    if (sides.orig.binary || (sides.mod && sides.mod.binary) || (meta && !meta.model)) {
      releaseDiff(dd);
      return { binary: true };
    }
    const lang = languageFor(d.path);
    const oref = d.mode === 'c' ? `${d.sha.slice(0, 7)}^` : d.mode === 's' ? 'HEAD' : 'index';
    const original = monaco.editor.createModel(sides.orig.text, lang, gitUri(oref, d.path));
    const owned = [original];
    let modified;
    if (meta) modified = meta.model;
    else {
      modified = monaco.editor.createModel(sides.mod ? sides.mod.text : '', lang, gitUri(d.mode === 'c' ? d.sha.slice(0, 7) : d.mode === 's' ? 'index' : 'worktree', d.path));
      owned.push(modified);
    }
    const old = dd.owned.splice(0);
    dd.ed.setModel({ original, modified });
    old.forEach(m => m.dispose());
    Object.assign(dd, { owned, shown: true, key, mode: d.mode, path: d.path, root: r });
    dd.ed.getModifiedEditor().updateOptions({ readOnly: d.mode !== 'w' || !meta });
    if (Lay().focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
    renderStatus();
    return { model: true };
  }

  /** Re-read the git side(s) of every visible diff after the index / HEAD moved. */
  async function refreshDiffs(r) {
    for (const dd of [...diffs.values()]) {
      if (!dd.shown || dd.root !== r || dd.mode === 'c' || dd.mode === 't') continue; // commits never change
      const key = dd.key;
      let sides;
      try { sides = await diffSides(r, dd.mode, dd.path); } catch { continue; }
      if (!dd.shown || dd.key !== key || sides.orig.binary) continue;
      const cur = dd.ed.getModel();
      if (!cur) continue;
      if (cur.original.getValue() !== sides.orig.text) cur.original.setValue(sides.orig.text);
      if (dd.mode === 's' && sides.mod && !sides.mod.binary && cur.modified.getValue() !== sides.mod.text) cur.modified.setValue(sides.mod.text);
    }
  }

  /** Diff of two texts that aren't in git (an agent's edit from a chat tab). */
  async function openTextDiff(path, oldText, newText) {
    const key = `d:t:${++textDiffSeq}:${path}`;
    textDiffs.set(key, { oldText: oldText == null ? '' : String(oldText), newText: newText == null ? '' : String(newText) });
    await whenReady();
    const gid = await Lay().openKey(key, { pin: true });
    if (gid) focusGroup(gid);
  }

  async function openDiff(mode, path, opts = {}) {
    await whenReady();
    const gid = await Lay().openDiff(mode, path, opts);
    if (gid) focusGroup(gid);
  }

  /** Free the model of a diff tab replaced in place, unless a file tab still has it. */
  function dropDiff(key) {
    const d = parseDiff(key);
    const m = d && d.mode === 'w' ? models.get(d.path) : null;
    if (m && !isOpenInTab(d.path)) freeModel(m, d.path);
  }

  async function closeDiff(key) {
    const d = parseDiff(key);
    if (!d) return;
    const m = d.mode === 'w' ? models.get(d.path) : null;
    if (isDirty(m) && !Lay().hasKey(`f:${d.path}`) && !confirm(`${base(d.path)} has unsaved changes. Close anyway?`)) return;
    Lay().removeKey(key);
    textDiffs.delete(key);
    if (m && !isOpenInTab(d.path)) freeModel(m, d.path);
  }

  // ------------------------------------------------------------------ navigation history

  function pushHistory() {
    if (!editor || !editor.getModel()) return;
    const m = metaOf(editor.getModel());
    if (!m) return;
    const p = editor.getPosition();
    history.splice(historyPos + 1);
    history.push({ path: m.path, line: p.lineNumber, col: p.column });
    if (history.length > 100) history.shift();
    historyPos = history.length - 1;
  }
  function goHistory(dir) {
    if (dir < 0 && historyPos === history.length - 1) { pushHistory(); historyPos--; }
    const i = historyPos + dir;
    const h = history[i];
    if (!h) return;
    historyPos = i;
    openFile(h.path, { selection: { lineNumber: h.line, column: h.col }, recordHistory: false });
  }

  // ------------------------------------------------------------------ diagnostics

  const SEV = () => ({ 1: monaco.MarkerSeverity.Error, 2: monaco.MarkerSeverity.Warning, 3: monaco.MarkerSeverity.Info, 4: monaco.MarkerSeverity.Hint });
  function setDiagnostics(m, diags) {
    m.diags = diags;
    if (!m.model) return;
    const sev = SEV();
    monaco.editor.setModelMarkers(m.model, 'lsp', diags.map(d => ({
      severity: sev[d.severity || 1], message: d.message, source: d.source,
      code: d.code !== undefined ? String(d.code) : undefined,
      startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1,
      tags: (d.tags || []).map(t => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
    })));
    renderTabs();
    renderStatus();
  }

  H.onDiagnostics((_root, p) => {
    const path = uriToPath(p.uri);
    if (!path) return;
    const m = models.get(path);
    if (m) setDiagnostics(m, p.diagnostics || []);
    else pendingDiags.set(path, p.diagnostics || []);
  });

  // ------------------------------------------------------------------ workspace edits

  function editsByFile(edit) {
    const out = new Map();
    const add = (uri, edits) => {
      const p = uriToPath(uri);
      if (!p) return;
      if (!out.has(p)) out.set(p, []);
      out.get(p).push(...edits);
    };
    if (edit.changes) for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
    if (edit.documentChanges) for (const dc of edit.documentChanges) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
    return out;
  }

  async function applyWorkspaceEdit(edit) {
    for (const [path, edits] of editsByFile(edit)) {
      const m = models.get(path);
      if (m && m.model) {
        m.model.pushEditOperations([], edits.map(e => ({ range: toRange(e.range), text: e.newText })), () => null);
      } else {
        try { await H.applyEditsToDisk(path, edits); } catch (e) { toast(`Edit failed for ${base(path)}: ${e.message}`); }
      }
    }
  }
  H.onApplyEdit((_root, e) => applyWorkspaceEdit(e));

  async function toMonacoWorkspaceEdit(edit) {
    const result = { edits: [] };
    for (const [path, edits] of editsByFile(edit)) {
      await ensureModel(path).catch(() => null);
      for (const e of edits) result.edits.push({ resource: monaco.Uri.file(path), textEdit: { range: toRange(e.range), text: e.newText }, versionId: undefined });
    }
    return result;
  }

  // ------------------------------------------------------------------ LSP → Monaco providers

  const KIND_NAMES = [null, 'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'];

  async function toLocations(res) {
    if (!res) return [];
    const arr = Array.isArray(res) ? res : [res];
    const out = [];
    for (const l of arr) {
      const uri = l.targetUri || l.uri;
      const range = l.targetSelectionRange || l.targetRange || l.range;
      const p = uriToPath(uri);
      if (!p || !range) continue;
      try { await ensureModel(p); } catch { continue; }
      out.push({ uri: monaco.Uri.file(p), range: toRange(range) });
    }
    return out;
  }

  function registerProviders() {
    const langs = ['typescript', 'javascript', 'ruby', 'html'];
    const L = monaco.languages;
    for (const lang of langs) {
      L.registerCompletionItemProvider(lang, {
        triggerCharacters: ['.', ':', '"', "'", '/', '@', '<', '#', '$'],
        async provideCompletionItems(model, position, ctx) {
          const m = metaOf(model);
          if (!m || !m.lspOpen) return { suggestions: [] };
          const res = await req(model, 'textDocument/completion', {
            position: toLspPos(position),
            context: ctx.triggerKind === 1 && ctx.triggerCharacter ? { triggerKind: 2, triggerCharacter: ctx.triggerCharacter } : { triggerKind: ctx.triggerKind === 2 ? 3 : 1 },
          });
          if (!res) return { suggestions: [] };
          const items = Array.isArray(res) ? res : res.items || [];
          const word = model.getWordUntilPosition(position);
          const def = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
          const suggestions = items.slice(0, 1000).map(it => {
            const te = it.textEdit;
            let range = def, insertText = it.insertText ?? (typeof it.label === 'string' ? it.label : it.label.label);
            if (te) {
              insertText = te.newText;
              range = te.range ? toRange(te.range) : { insert: toRange(te.insert), replace: toRange(te.replace) };
            }
            return {
              label: it.labelDetails ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description } : it.label,
              kind: L.CompletionItemKind[KIND_NAMES[it.kind] || 'Text'] ?? L.CompletionItemKind.Text,
              detail: it.detail, documentation: docString(it.documentation),
              sortText: it.sortText, filterText: it.filterText, preselect: it.preselect,
              insertText, range,
              insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : 0,
              additionalTextEdits: (it.additionalTextEdits || []).map(e => ({ range: toRange(e.range), text: e.newText })),
              commitCharacters: it.commitCharacters,
              tags: it.deprecated || (it.tags || []).includes(1) ? [L.CompletionItemTag.Deprecated] : [],
              _lsp: it, _meta: m,
            };
          });
          return { suggestions, incomplete: !Array.isArray(res) && !!res.isIncomplete };
        },
        async resolveCompletionItem(item) {
          const m = item._meta;
          if (!m || !m.lspOpen || item.documentation) return item;
          try {
            const r = await H.lspRequest(m.root, m.kind, 'completionItem/resolve', item._lsp);
            if (r) {
              item.documentation = docString(r.documentation) || item.documentation;
              item.detail = r.detail || item.detail;
              if (r.additionalTextEdits) item.additionalTextEdits = r.additionalTextEdits.map(e => ({ range: toRange(e.range), text: e.newText }));
            }
          } catch { /* not supported */ }
          return item;
        },
      });

      L.registerHoverProvider(lang, {
        async provideHover(model, position) {
          const r = await req(model, 'textDocument/hover', { position: toLspPos(position) });
          if (!r || !r.contents) return null;
          const contents = markdown(r.contents);
          return contents.length ? { contents, range: r.range ? toRange(r.range) : undefined } : null;
        },
      });

      L.registerDefinitionProvider(lang, {
        async provideDefinition(model, position) {
          pushHistory();
          return toLocations(await req(model, 'textDocument/definition', { position: toLspPos(position) }));
        },
      });
      L.registerTypeDefinitionProvider(lang, {
        async provideTypeDefinition(model, position) { return toLocations(await req(model, 'textDocument/typeDefinition', { position: toLspPos(position) })); },
      });
      L.registerImplementationProvider(lang, {
        async provideImplementation(model, position) { return toLocations(await req(model, 'textDocument/implementation', { position: toLspPos(position) })); },
      });
      L.registerReferenceProvider(lang, {
        async provideReferences(model, position, ctx) {
          return toLocations(await req(model, 'textDocument/references', { position: toLspPos(position), context: { includeDeclaration: ctx.includeDeclaration } }));
        },
      });

      L.registerSignatureHelpProvider(lang, {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [')'],
        async provideSignatureHelp(model, position) {
          const r = await req(model, 'textDocument/signatureHelp', { position: toLspPos(position) });
          if (!r || !r.signatures || !r.signatures.length) return null;
          return {
            value: {
              signatures: r.signatures.map(s => ({
                label: s.label, documentation: docString(s.documentation),
                parameters: (s.parameters || []).map(p => ({ label: p.label, documentation: docString(p.documentation) })),
                activeParameter: s.activeParameter,
              })),
              activeSignature: r.activeSignature || 0,
              activeParameter: r.activeParameter || 0,
            },
            dispose() {},
          };
        },
      });

      L.registerDocumentHighlightProvider(lang, {
        async provideDocumentHighlights(model, position) {
          const r = await req(model, 'textDocument/documentHighlight', { position: toLspPos(position) });
          return (r || []).map(h => ({ range: toRange(h.range), kind: (h.kind || 1) - 1 }));
        },
      });

      L.registerDocumentSymbolProvider(lang, {
        displayName: 'LSP',
        async provideDocumentSymbols(model) {
          const r = await req(model, 'textDocument/documentSymbol');
          const conv = s => {
            const range = toRange(s.range || s.location.range);
            return {
              name: s.name, detail: s.detail || '', kind: Math.max(0, (s.kind || 1) - 1), tags: [],
              range, selectionRange: s.selectionRange ? toRange(s.selectionRange) : range,
              children: (s.children || []).map(conv),
            };
          };
          return (r || []).map(conv);
        },
      });

      L.registerRenameProvider(lang, {
        async provideRenameEdits(model, position, newName) {
          const r = await req(model, 'textDocument/rename', { position: toLspPos(position), newName });
          if (!r) return { edits: [], rejectReason: 'Nothing to rename here' };
          return toMonacoWorkspaceEdit(r);
        },
      });

      L.registerDocumentFormattingEditProvider(lang, {
        async provideDocumentFormattingEdits(model, options) {
          const r = await req(model, 'textDocument/formatting', { options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces } });
          return (r || []).map(e => ({ range: toRange(e.range), text: e.newText }));
        },
      });

      L.registerCodeActionProvider(lang, {
        async provideCodeActions(model, range, ctx) {
          const m = metaOf(model);
          if (!m || !m.lspOpen) return { actions: [], dispose() {} };
          const diags = m.diags.filter(d => toRange(d.range).intersectRanges(range));
          const r = await req(model, 'textDocument/codeAction', { range: toLspRange(range), context: { diagnostics: diags, only: ctx.only ? [ctx.only] : undefined, triggerKind: ctx.trigger === 1 ? 1 : 2 } });
          const actions = [];
          for (const a of r || []) {
            if (a.command && typeof a.command === 'string') { // bare Command
              actions.push({ title: a.title, command: { id: 'harbor.lsp.exec', title: a.title, arguments: [m.root, m.kind, a] } });
              continue;
            }
            const act = { title: a.title, kind: a.kind, isPreferred: a.isPreferred, diagnostics: [], _lsp: a, _meta: m };
            if (a.edit) act.edit = await toMonacoWorkspaceEdit(a.edit);
            if (a.command) act.command = { id: 'harbor.lsp.exec', title: a.command.title, arguments: [m.root, m.kind, a.command] };
            actions.push(act);
          }
          return { actions, dispose() {} };
        },
        async resolveCodeAction(action) {
          if (action.edit || !action._lsp || !action._meta) return action;
          try {
            const r = await H.lspRequest(action._meta.root, action._meta.kind, 'codeAction/resolve', action._lsp);
            if (r && r.edit) action.edit = await toMonacoWorkspaceEdit(r.edit);
          } catch { /* */ }
          return action;
        },
      });
    }

    monaco.editor.registerCommand('harbor.lsp.exec', (_acc, r, kind, cmd) => H.lspRequest(r, kind, 'workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments }).catch(() => {}));

    // go-to-definition, peek "open", reference clicks -> open as a Tawny tab
    monaco.editor.registerEditorOpener({
      openCodeEditor(_src, resource, sel) {
        if (resource.scheme !== 'file') return false;
        openFile(resource.path, { selection: sel, recordHistory: false });
        return true;
      },
    });
    // links inside hovers (ruby-lsp: file:///…#L12,3)
    if (monaco.editor.registerLinkOpener) {
      monaco.editor.registerLinkOpener({
        open(uri) {
          if (uri.scheme !== 'file') return false;
          const mm = /L(\d+)(?:,(\d+))?/.exec(uri.fragment || '');
          openFile(uri.path.replace(/\/{2,}/g, '/'), { selection: mm ? { lineNumber: +mm[1], column: +(mm[2] || 1) } : undefined });
          return true;
        },
      });
    }
  }

  // ------------------------------------------------------------------ file tree (React: components/tree)

  const Tree = () => window.harborTree;
  const refreshGit = () => Tree().refreshGit();
  const revealInTree = path => Tree().revealInTree(path);
  const markTreeActive = () => Tree().markActive();

  H.onFsChanged((r, paths) => {
    for (const p of paths) if (models.has(p)) reloadFromDisk(p);
  });

  // ------------------------------------------------------------------ ⌘P

  function fuzzy(q, s) {
    // subsequence match with bonuses for consecutive chars and basename hits
    q = q.toLowerCase();
    const sl = s.toLowerCase();
    const b = sl.lastIndexOf('/') + 1;
    let qi = 0, score = 0, last = -2;
    const hits = [];
    for (let i = 0; i < sl.length && qi < q.length; i++) {
      if (sl[i] === q[qi]) {
        score += (i === last + 1 ? 5 : 1) + (i >= b ? 3 : 0) + (i === b || s[i - 1] === '/' || s[i - 1] === '_' || s[i - 1] === '-' || s[i - 1] === '.' ? 4 : 0);
        hits.push(i); last = i; qi++;
      }
    }
    if (qi < q.length) return null;
    score -= s.length * 0.02;
    if (sl.slice(b).startsWith(q)) score += 15;
    return { score, hits };
  }

  // file mode of the command palette (app.js): empty input = go to file, '>' prefix = commands
  const openQuickOpen = () => root && window.harborApp.openPalette('');
  const fileIndexLoaded = () => indexByRoot.has(root);
  async function loadFileIndex() {
    const r = root;
    if (!indexByRoot.has(r)) indexByRoot.set(r, await H.fileIndex(r).catch(() => []));
  }

  function fileMatches(raw) {
    const [q, line] = raw.trim().split(':');
    const files = indexByRoot.get(root) || [];
    let res;
    if (!q) {
      const recent = Lay().filesOf(root).reverse().map(p => rel(p));
      res = [...new Set([...recent, ...files])].slice(0, 60).map(f => ({ f, hits: [] }));
    } else {
      res = [];
      for (const f of files) { const m = fuzzy(q.replace(/\s+/g, ''), f); if (m) res.push({ f, ...m }); }
      res.sort((a, b) => b.score - a.score);
      res = res.slice(0, 60);
    }
    return res.map(r => ({ ...r, line: Number(line) || 0 }));
  }

  function fileRowHtml(r) {
    const hit = new Set(r.hits);
    const b = r.f.lastIndexOf('/') + 1;
    const hl = (from, to) => [...r.f.slice(from, to)].map((c, j) => (hit.has(from + j) ? `<b>${esc(c)}</b>` : esc(c))).join('');
    return `<span class="qf">${hl(b, r.f.length)}</span><span class="r">${hl(0, Math.max(0, b - 1))}</span>`;
  }

  const absPath = f => (f.startsWith('/') ? f : `${root}/${f}`);

  /** Syntax-highlighted lines (HTML) of `text` as `path`'s language, or null when too long or unavailable. */
  async function colorizeLines(text, path) {
    await whenReady();
    if (text.length > 60000) return null;
    try { return (await monaco.editor.colorize(text, languageFor(path), { tabSize: 2 })).split(/<br\s*\/?>/); } catch { return null; }
  }

  /** Unsaved text of an open file, or null when it isn't open or has no unsaved changes (for `fs/read_text_file`). */
  function dirtyText(path) {
    const m = models.get(path);
    return m && m.model && isDirty(m) ? m.model.getValue() : null;
  }

  function openFileResult(r) {
    const p = absPath(r.f);
    return openFile(p, r.line ? { selection: { lineNumber: r.line, column: 1 } } : {});
  }

  // ------------------------------------------------------------------ status bar

  function renderStatus() {
    const el = $('#edStatus');
    if (!el) return;
    el.hidden = !Lay().activeFile();
    if (el.hidden) return;
    const m = editor && editor.getModel() ? metaOf(editor.getModel()) : models.get(Lay().activeFile());
    const parts = [];
    let lspHtml = '';
    if (m && m.kind) {
      const st = lspStatus.find(s => s.root === m.root && s.kind === m.kind);
      if (st) {
        if (st.state === 'error') {
          lspHtml = `<span class="lsp err" title="${esc(st.error)}">⚠ ${esc(st.name)} not running</span>`
            + (st.installable ? '<button class="sbtn" data-act="installRuby">Install ruby-lsp</button>' : '')
            + '<button class="sbtn" data-act="lspRestart">Retry</button><button class="sbtn" data-act="lspDetails">Details</button>';
        } else if (st.state === 'starting') lspHtml = `<span class="lsp busy"><i class="mini-spin"></i>${esc(st.name)} starting…</span>`;
        else if (st.progress) lspHtml = `<span class="lsp busy"><i class="mini-spin"></i>${esc(st.progress)}</span>`;
        else lspHtml = `<span class="lsp ok">● ${esc(st.name)}</span>`;
      }
    } else if (m && m.model) lspHtml = '<span class="lsp off">No language server</span>';
    parts.push(lspHtml);
    if (m && m.model) {
      const errs = m.diags.filter(d => d.severity === 1).length, warns = m.diags.filter(d => d.severity === 2).length;
      parts.push(`<span class="probs" data-act="problems" title="Next problem (F8)">⊗ ${errs} ⚠ ${warns}</span>`);
    }
    const pos = editor && editor.getModel() ? editor.getPosition() : null;
    el.innerHTML = `<div class="sl">${parts.join('')}</div><div class="sr">${m && m.conflict ? '<span class="lsp err">File changed on disk — save to overwrite or close to discard</span>' : ''}${pos ? `<span>Ln ${pos.lineNumber}, Col ${pos.column}</span>` : ''}${m && m.model ? `<span>${esc(m.model.getLanguageId())}</span>` : ''}</div>`;
  }

  $('#edStatus').addEventListener('click', async e => {
    const act = e.target.dataset.act;
    const m = editor && editor.getModel() ? metaOf(editor.getModel()) : null;
    if (!act || !m) return;
    if (act === 'lspRestart') { await H.lspRestart(m.root, m.kind); }
    else if (act === 'lspDetails') {
      const st = lspStatus.find(s => s.root === m.root && s.kind === m.kind);
      alert(st ? st.error : 'No details');
    } else if (act === 'installRuby') {
      e.target.textContent = 'Installing…'; e.target.disabled = true;
      try { await H.lspInstallRuby(m.root); toast('ruby-lsp installed'); } catch (err) { alert(`gem install ruby-lsp failed:\n\n${err.message}`); }
    } else if (act === 'problems') { editor.focus(); editor.trigger('harbor', 'editor.action.marker.next', null); }
  });

  H.onLspRestarted(async (r, kind) => {
    for (const m of models.values()) {
      if (m.root === r && m.kind === kind && m.model && isOpenInTab(m.path)) { m.lspOpen = false; await openLsp(m); }
    }
  });

  // ------------------------------------------------------------------ misc UI

  function toast(msg) { window.harborApp && window.harborApp.toast(msg); }

  function showContextMenu(x, y, items) {
    const menuEl = $('#ctxMenu');
    menuEl.innerHTML = items.map((it, i) => `<div class="ci" data-i="${i}">${esc(it.label)}</div>`).join('');
    menuEl.hidden = false;
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    menuEl.style.left = `${Math.min(x, innerWidth - w - 6)}px`;
    menuEl.style.top = `${Math.min(y, innerHeight - h - 6)}px`;
    const close = () => { menuEl.hidden = true; document.removeEventListener('mousedown', outside, true); };
    const outside = ev => { if (!menuEl.contains(ev.target)) close(); };
    document.addEventListener('mousedown', outside, true);
    menuEl.querySelectorAll('.ci').forEach(el => el.onclick = () => { close(); items[+el.dataset.i].run(); });
  }

  // ------------------------------------------------------------------ init

  function whenReady() { return ready ? Promise.resolve() : new Promise(r => readyWaiters.push(r)); }

  function defineTheme() {
    for (const t of window.harborTheme.monacoThemes()) monaco.editor.defineTheme(t.id, t.def);
    monaco.editor.setTheme(window.harborTheme.monaco().id);
    window.harborTheme.onChange(() => { monaco.editor.setTheme(window.harborTheme.monaco().id); });
  }

  function disableBuiltinTs() {
    const ts = monaco.languages.typescript || monaco.typescript;
    if (!ts) return;
    const off = { completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false, documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false, signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false };
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      if (!d) continue;
      try { d.setModeConfiguration(off); } catch { /* old api */ }
      try { d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true }); } catch { /* */ }
    }
  }

  function createEditor(gid, host) {
    const ed = monaco.editor.create(host, {
      model: null, theme: window.harborTheme.monaco().id, automaticLayout: true,
      fontFamily: settings.editorFontFamily || '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
      fontSize: settings.editorFontSize || 13, lineHeight: Math.round((settings.editorFontSize || 13) * 1.6),
      minimap: { enabled: false }, glyphMargin: true,
      scrollBeyondLastLine: false, smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
      bracketPairColorization: { enabled: true }, guides: { bracketPairs: 'active', indentation: true },
      padding: { top: 8 }, fixedOverflowWidgets: true, renderWhitespace: 'selection', stickyScroll: { enabled: true },
      tabSize: 2, detectIndentation: true, wordBasedSuggestions: 'off', quickSuggestions: { other: true, comments: false, strings: true },
      'semanticHighlighting.enabled': false, inlayHints: { enabled: 'off' }, links: true, mouseWheelZoom: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    editors.set(gid, ed);
    window.harborDebug.attach(ed);
    const pill = document.createElement('div');
    pill.className = 'rich-toggle';
    pill.hidden = true;
    pill.innerHTML = '<button data-m="source">Source</button><button data-m="rich">Rich</button>';
    pill.addEventListener('mousedown', e => e.preventDefault());
    pill.addEventListener('click', e => {
      const b = e.target.closest('button');
      const mm = ed.getModel() && metaOf(ed.getModel());
      if (b && mm) setRich(mm.path, b.dataset.m === 'rich');
    });
    host.append(pill);
    hosts.set(gid, { host, pill });
    if (!editor) editor = ed;
    ed.onDidChangeCursorPosition(() => { if (ed === editor) renderStatus(); });
    ed.onDidFocusEditorWidget(() => { editor = ed; Lay().focusGroup(gid); });
    // back / forward (VS Code bindings)
    ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Minus, () => goHistory(-1));
    ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => goHistory(1));
    // Chromium's rich-text ToggleBold swallows ⌘B in the editor before the menu accelerator fires
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => window.harborApp.toggleSidebar());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => window.harborApp.openPalette());  // replaces Monaco's own palette
    addMoveTabKeys(ed);
    asks.set(ed, codeAsk(ed));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => sendSelectionToAgent());
    ed.addAction({
      id: 'harbor.sendToAgent', label: 'Send Selection to Agent', contextMenuGroupId: '9_harbor', contextMenuOrder: 1,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL],
      run: () => sendSelectionToAgent(),
    });
    return ed;
  }

  /** Message box in a view zone just below the selection's last line: the code below is pushed down rather than covered, so all of it stays visible.
   *  focus() opens it and returns true, or false when nothing is selected. Cmd+enter sends, escape closes, shift+tab cycles agents. */
  function codeAsk(ed) {
    const dom = document.createElement('div');
    dom.className = 'rich-ask';
    dom.innerHTML = '<textarea rows="2" placeholder="Message agent about this selection…" spellcheck="false"></textarea>'
      + '<div class="ask-foot"><span class="ask-agent" hidden><i class="sdot"></i><span></span></span>'
      + '<button type="button" class="ask-send">Send <kbd>⌘↵</kbd></button></div>';
    const ta = dom.querySelector('textarea'), chip = dom.querySelector('.ask-agent');
    const dot = chip.firstChild, name = chip.lastChild;
    const zoneDom = document.createElement('div');
    zoneDom.className = 'ask-zone';
    zoneDom.append(dom);
    let agents = [], idx = 0, zoneId = null, zone = null;
    const shown = () => zoneId !== null;
    const fit = () => {
      if (!shown()) return;
      zone.heightInPx = dom.offsetHeight + 12;
      ed.changeViewZones(a => a.layoutZone(zoneId));
    };
    const renderAgent = () => {
      const a = agents[idx];
      chip.hidden = !a;
      if (!a) return;
      name.textContent = a.label;
      dot.className = 'sdot' + (a.waiting ? ' wait' : a.working ? ' work' : '');
      chip.title = agents.length > 1 ? 'shift+tab: next agent' : '';
    };
    const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; fit(); };
    const hide = () => { if (!shown()) return; const id = zoneId; zoneId = null; ed.changeViewZones(a => a.removeZone(id)); };
    const submit = () => {
      const msg = ta.value.trim();
      const ref = selectionRef();
      const id = agents[idx]?.id;
      ta.value = '';
      grow();
      hide();
      ed.focus();
      if (ref) window.harborApp.askAgent(ref, msg, id);
    };
    dom.querySelector('.ask-send').addEventListener('click', submit);
    dom.addEventListener('mousedown', e => { if (e.target !== ta) e.preventDefault(); });   // keep focus where it is
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); submit(); }
      else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); if (agents.length > 1) { idx = (idx + 1) % agents.length; renderAgent(); } }
      else if (e.key === 'Escape') { e.preventDefault(); hide(); ed.focus(); }
    });
    ta.addEventListener('focusout', e => { if (!dom.contains(e.relatedTarget)) hide(); });
    ed.onDidChangeCursorSelection(() => { if (!dom.contains(document.activeElement)) hide(); });   // back to editing: drop the box
    ed.onDidChangeModel(hide);
    return {
      focus() {
        const s = ed.getSelection();
        if (!s || s.isEmpty()) return false;
        if (!shown()) {
          ({ agents, index: idx } = window.harborApp.sendTargets());
          renderAgent();
          const last = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber;   // as in selectionRef
          zone = { afterLineNumber: last, heightInPx: 110, domNode: zoneDom, suppressMouseDown: true };
          ed.changeViewZones(a => { zoneId = a.addZone(zone); });
          ed.revealLineInCenterIfOutsideViewport(last);
        }
        requestAnimationFrame(() => { if (shown()) { fit(); ta.focus(); } });   // the zone is laid out on Monaco's next render
        return true;
      },
    };
  }

  /** Monaco claims cmd+opt+shift+arrows (cursors, copy line) before the menu accelerators fire. */
  function addMoveTabKeys(ed) {
    const m = monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyMod.Shift;
    for (const [code, dir] of [['LeftArrow', -1], ['RightArrow', 1], ['UpArrow', 'up'], ['DownArrow', 'down']]) {
      ed.addCommand(m | monaco.KeyCode[code], () => Lay().moveActive(dir));
    }
  }

  function init(state) {
    settings = state.settings || {};
    const size = settings.editorFontSize || 13;
    const ui = state.ui || {};
    window.MonacoEnvironment = {
      // No web workers from file:// — Monaco runs its small editor worker on the main thread instead.
      getWorker() { throw new Error('workers disabled'); },
    };
    window.require.config({ paths: { vs: './monaco/vs' } });
    window.require(['vs/editor/editor.main'], () => {
      defineTheme();
      disableBuiltinTs();
      registerProviders();
      window.harborDebug.init(ui);
      ready = true;
      readyWaiters.splice(0).forEach(f => f());
      if (root) setRoot(root, true);
    });
  }

  /** "@file#L3-5" for the focused editor's selection (the whole file when nothing is selected); null without a file. */
  function selectionRef() {
    const model = editor.getModel();
    const m = metaOf(model);
    if (!m) return null;
    let a, b;
    const gid = [...editors].find(([, e]) => e === editor)?.[0];
    const rv = gid && richViews.get(gid);
    if (rv && rv.path === m.path && !rv.view.el.hidden) {
      // rich view on top: its selection is mapped back onto the markdown source
      const r = rv.view.selectionLines(model.getValue());
      if (r) [a, b] = r;
    } else {
      const s = editor.getSelection();
      if (s && !s.isEmpty()) { a = s.startLineNumber; b = s.endColumn === 1 && s.endLineNumber > a ? s.endLineNumber - 1 : s.endLineNumber; }
    }
    let ref = `@${rel(m.path)}`;
    if (a) ref += a === b ? `#L${a}` : `#L${a}-${b}`;
    return ref;
  }

  function sendSelectionToAgent() {
    const m = metaOf(editor.getModel());
    const gid = [...editors].find(([, e]) => e === editor)?.[0];
    const rv = gid && richViews.get(gid);
    if (m && rv && rv.path === m.path && !rv.view.el.hidden && rv.view.focusAsk()) return;   // rich view: type into the box over the selection
    if (asks.get(editor)?.focus()) return;   // code editor: type into the box beside the selection
    const ref = selectionRef();
    if (ref) window.harborApp.composeToAgent(ref);
  }

  async function setRoot(r, force) {
    if (!force && r === root) return;
    root = r;
    if (r) knownRoots.add(r);
    if (!ready) return;
    Tree().setRoot(r);
    if (r && !indexByRoot.has(r)) H.fileIndex(r).then(f => indexByRoot.set(r, f)).catch(() => {});
  }

  window.harborEditor = {
    init, setRoot, openFile, openQuickOpen, fileIndexLoaded, loadFileIndex, fileMatches, fileRowHtml, openFileResult, absPath, colorizeLines, dirtyText, openTextDiff, showContextMenu,
    save: () => save(),
    closeTab, dropPath,
    renderTabs,
    show, preload, tabInfo, saveView, focusGroup, groupFocused, disposeGroup, revealInTree,
    layoutGroup: gid => { const ed = editors.get(gid), dd = diffs.get(gid); if (ed) ed.layout(); if (dd) dd.ed.layout(); },
    showDiff, diffInfo, closeDiff, dropDiff, openDiff,
    invalidateIndex: r => indexByRoot.delete(r),
    refreshDiffs,
    /** Text of the focused editor's single-line selection, '' when none (or the editor isn't focused). */
    selectedText() {
      const sel = editor && editor.hasTextFocus() && editor.getSelection();
      return sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber ? editor.getModel().getValueInRange(sel) : '';
    },
    /** Text of `path`'s open model (null when it isn't open). */
    modelText: path => models.get(path)?.model?.getValue() ?? null,
    /** Apply replace edits [{ l, c, n, text }] to `path`'s open model (left unsaved). */
    applyModelEdits(path, edits) {
      const model = models.get(path)?.model;
      if (model) model.pushEditOperations([], edits.map(e => ({ range: new monaco.Range(e.l, e.c + 1, e.l, e.c + 1 + e.n), text: e.text })), () => null);
    },
    toggleRich,
    focus() {
      const gid = [...editors].find(([, e]) => e === editor);
      const rv = gid && richViews.get(gid[0]);
      if (rv && rv.path) rv.view.focus(); else if (editor) editor.focus();
    },
    setLspStatus(list) { lspStatus = list || []; renderStatus(); },
    dirtyCount: r => [...models.values()].filter(m => m.root === r && isDirty(m)).length,
    forgetRoot(r) { knownRoots.delete(r); Tree().forgetRoot(r); indexByRoot.delete(r); Lay().forgetRoot(r); },
    get editor() { return editor; },
    get root() { return root; },
  };
})();

export {};
