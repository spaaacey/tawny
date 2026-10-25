'use strict';
/* global monaco */
// Harbor editor: Monaco + language servers (via main process), tabs, file tree, ⌘P file search.
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
  const richViews = new Map();     // group id -> { view (Tiptap, window.harborRich), path, text, syncing } while created
  const richOverride = new Map();  // markdown path -> true/false once toggled; otherwise settings.richMarkdown decides (default: rich)
  let editor = null;               // the editor of the focused group
  let root = null;                 // active worktree
  let settings = {};
  let lspStatus = [];
  const models = new Map();        // path -> meta
  const knownRoots = new Set();
  const expandedByRoot = new Map();// root -> Set(dir)
  const dirCache = new Map();      // dir -> entries
  const gitByRoot = new Map();     // root -> { rel: code }
  const statByRoot = new Map();    // root -> { add, del } lines across uncommitted changes
  const changesByRoot = new Map(); // root -> { staged: [{path, status, orig?}], unstaged: [...] }
  const notRepo = new Set();       // roots that aren't inside a git repo (folder / scratch workspaces)
  const logByRoot = new Map();     // root -> [{ sha, short, author, time, refs, subject }] (HEAD's recent commits)
  const commitFiles = new Map();   // sha -> [{ path, status, orig? }] | null while loading
  const openCommits = new Set();   // expanded shas in the Source pane
  const commitDrafts = new Map();  // root -> unsent commit message
  const selected = new Set();      // multi-selected Source rows: `${mode}\0${abs}` (all the same mode, 's' or 'w')
  let selAnchor = null;            // last plain/cmd-clicked row key, start of shift ranges
  let commitBoxRoot = null;        // root whose draft is currently in the textarea
  const diffs = new Map();         // group id -> { ed (diff editor), shown, key, mode, path, root, owned: [in-memory models] }
  let treeView = 'files';          // 'files' | 'changes'
  const collapsedSecs = new Set(['commits']); // Commits starts collapsed
  const indexByRoot = new Map();   // root -> [rel]
  const pendingDiags = new Map();  // path -> lsp diagnostics
  const history = [];              // [{path, line, col}] for go back
  let historyPos = -1;
  let treeVisible = true;
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
        keys: {
          'Mod-b': () => $('#app').classList.toggle('no-sidebar'),
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
  // 'd:c:<sha>:<path>' = a commit (parent ↔ commit, read-only).

  function parseDiff(key) {
    const m = /^d:([swc]):(.*)$/.exec(key || '');
    if (!m) return null;
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
      const ch = (commitFiles.get(sha) || []).find(x => x.path === rl);
      const [orig, mod] = await Promise.all([H.gitShow(r, (ch && ch.orig) || rl, `${sha}^`), H.gitShow(r, rl, sha)]);
      return { orig, mod };
    }
    const c = changesByRoot.get(r);
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
      side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => $('#app').classList.toggle('no-sidebar'));
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
      if (!dd.shown || dd.root !== r || dd.mode === 'c') continue; // commits never change
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

  async function openDiff(mode, path) {
    await whenReady();
    const gid = await Lay().openDiff(mode, path);
    if (gid) focusGroup(gid);
  }

  async function closeDiff(key) {
    const d = parseDiff(key);
    if (!d) return;
    const m = d.mode === 'w' ? models.get(d.path) : null;
    if (isDirty(m) && !Lay().hasKey(`f:${d.path}`) && !confirm(`${base(d.path)} has unsaved changes. Close anyway?`)) return;
    Lay().removeKey(key);
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

    // go-to-definition, peek "open", reference clicks -> open as a Harbor tab
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

  // ------------------------------------------------------------------ file tree

  const expanded = () => {
    if (!expandedByRoot.has(root)) expandedByRoot.set(root, new Set());
    return expandedByRoot.get(root);
  };

  async function listDir(dir, force) {
    if (!force && dirCache.has(dir)) return dirCache.get(dir);
    let ents = [];
    try { ents = await H.list(dir); } catch { ents = []; }
    dirCache.set(dir, ents);
    return ents;
  }

  /** Catppuccin icon file for a tree entry: exact file/folder name first, then the longest matching extension. */
  function iconFor(name, type, open) {
    const I = window.harborFileIcons;
    const n = name.toLowerCase();
    if (type === 'dir') return (open ? I.dirsOpen[n] : I.dirs[n]) || (open ? I.folderOpen : I.folder);
    if (I.files[n]) return I.files[n];
    for (let i = n.indexOf('.'); i !== -1; i = n.indexOf('.', i + 1)) {
      const hit = I.ext[n.slice(i + 1)];
      if (hit) return hit;
    }
    return I.file;
  }

  const CHEVRON = window.harborChevron;
  const actIcon = d => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const ACT_ICONS = {
    stage: actIcon('M8 3v10M3 8h10'),
    unstage: actIcon('M3 8h10'),
    discard: actIcon('M6.5 3 3.5 6l3 3M3.5 6H9a3.5 3.5 0 0 1 0 7H6'),
  };
  const ACT_TITLES = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard Changes' };
  const actBtn = (act, all) => `<span class="cn-act" data-act="${act}" title="${ACT_TITLES[act]}${all ? ' All' : ''}">${ACT_ICONS[act]}</span>`;
  const ago = t => {
    const m = Math.max(0, (Date.now() / 1000 - t) / 60);
    if (m < 1) return 'now';
    if (m < 60) return `${Math.floor(m)}m`;
    if (m < 1440) return `${Math.floor(m / 60)}h`;
    if (m < 43200) return `${Math.floor(m / 1440)}d`;
    return `${Math.floor(m / 43200)}mo`;
  };

  /** Source pane: Staged Changes / Changes (working tree), then the Commits (HEAD's recent commits, expandable to their files). */
  function renderChanges() {
    const el = $('#changes');
    const c = root && changesByRoot.get(root);
    const n = c ? c.staged.length + c.unstaged.length : 0;
    const stat = (root && statByRoot.get(root)) || { add: 0, del: 0 }, cs = $('#chgStat');
    cs.hidden = !n;
    if (n) cs.innerHTML = `<span class="pa">+${stat.add}</span><span class="pd">−${stat.del}</span>`;
    syncCommitBox(c, n);
    if (el.hidden) return;
    const log = (root && logByRoot.get(root)) || [];
    pruneSelection(c);
    if (root && notRepo.has(root)) { el.innerHTML = '<div class="tree-empty">Not a git repository</div>'; return; }
    if (!n && !log.length) { el.innerHTML = '<div class="tree-empty">No changes</div>'; return; }
    const flavor = window.harborTheme.name;
    const active = Lay().activeKey();
    const head = (id, label, count) => `<div class="cn-head" data-sec="${id}"><span class="tw${collapsedSecs.has(id) ? '' : ' open'}">${CHEVRON}</span>${label}`
      + (id === 'unstaged' ? actBtn('discard', true) : '')
      + (id === 'staged' || id === 'unstaged' ? actBtn(id === 'staged' ? 'unstage' : 'stage', true) : '')
      + `<span class="cn-n">${count}</span></div>`;
    const row = (f, mode) => {
      const abs = root + sep + f.path, name = base(f.path), i = f.path.lastIndexOf(sep);
      const act = mode === 's' ? 'unstage' : mode === 'w' ? 'stage' : '';
      return `<div class="cn s${f.status}${active === `d:${mode}:${abs}` ? ' on' : ''}${selected.has(selKey(mode, abs)) ? ' sel' : ''}" data-m="${mode}" data-p="${esc(abs)}" data-s="${f.status}"${f.orig ? ` data-o="${esc(f.orig)}"` : ''} title=""${esc(f.orig ? `${f.orig} → ${f.path}` : f.path)}">`
        + `<img class="ti" src="fileicons/${flavor}/${iconFor(name, 'file')}.svg" draggable="false"><span class="cn-name">${esc(name)}</span>`
        + `<span class="cn-dir">${esc(i > 0 ? f.path.slice(0, i) : '')}</span>`
        + (mode === 'w' ? actBtn('discard') : '') + (act ? actBtn(act) : '')
        + `<span class="tg">${f.status === '?' ? 'U' : f.status}</span></div>`;
    };
    const sec = (id, label, list, mode) => (!list.length ? '' : head(id, label, list.length) + (collapsedSecs.has(id) ? '' : list.map(f => row(f, mode)).join('')));
    const commit = cm => {
      const open = openCommits.has(cm.sha), files = commitFiles.get(cm.sha);
      return `<div class="cm${open ? ' open' : ''}" data-sha="${cm.sha}" title="${esc(`${cm.short} ${cm.author}\n${cm.subject}`)}"><span class="tw${open ? ' open' : ''}">${CHEVRON}</span>`
        + `<span class="cm-sub">${esc(cm.subject)}</span>${cm.refs.map(r => `<span class="cm-ref">${esc(r)}</span>`).join('')}<span class="cm-meta">${ago(cm.time)}</span></div>`
        + (open ? (files ? files.map(f => row(f, `c:${cm.sha}`)).join('') : '<div class="cm-load">…</div>') : '');
    };
    const top = el.querySelector('.cn-top'), bot = el.querySelector('.cn-log');
    const keep = top ? top.scrollTop : 0, keepLog = bot ? bot.scrollTop : 0;
    el.innerHTML = `<div class="cn-topwrap"><div class="cn-top">${sec('staged', 'Staged Changes', c ? c.staged : [], 's') + sec('unstaged', 'Changes', c ? c.unstaged : [], 'w')}</div></div>`
      + (log.length ? `<div class="cn-log">${head('commits', 'Commits', log.length) + (collapsedSecs.has('commits') ? '' : log.map(commit).join(''))}</div>` : '');
    el.querySelector('.cn-top').scrollTop = keep;
    const nb = el.querySelector('.cn-log');
    if (nb) nb.scrollTop = keepLog;
  }

  const commitMsg = $('#commitMsg'), commitBtn = $('#commitBtn');
  function fitCommitMsg() { commitMsg.style.height = 'auto'; commitMsg.style.height = Math.min(commitMsg.scrollHeight + 2, 140) + 'px'; }
  function syncCommitBox(c, n) {
    $('#commitBox').hidden = treeView !== 'changes' || !root || notRepo.has(root);
    if (commitBoxRoot !== root) {
      commitBoxRoot = root;
      commitMsg.value = commitDrafts.get(root) || '';
      fitCommitMsg();
    }
    const staged = c ? c.staged.length : 0;
    commitBtn.textContent = staged || !n ? 'Commit' : 'Commit All';
    commitBtn.disabled = !n || !commitMsg.value.trim();
  }
  commitMsg.addEventListener('input', () => {
    commitDrafts.set(root, commitMsg.value);
    fitCommitMsg();
    const c = changesByRoot.get(root);
    syncCommitBox(c, c ? c.staged.length + c.unstaged.length : 0);
  });
  async function doCommit() {
    if (commitBtn.disabled || !root) return;
    const r = root;
    commitBtn.disabled = true;
    try {
      await H.gitCommit(r, commitMsg.value);
      commitDrafts.delete(r);
      if (r === root) { commitMsg.value = ''; fitCommitMsg(); }
    } catch (e) { toast(`Commit failed: ${e.message}`); }
    refreshGit();
  }
  // No Undo/Select All menu roles (they'd hijack Monaco's own cmd+z / cmd+a), so the textarea handles them itself.
  commitMsg.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'enter') doCommit();
    else if (k === 'a') commitMsg.select();
    else if (k === 'z') document.execCommand(e.shiftKey ? 'redo' : 'undo');
    else return;
    e.preventDefault();
  });
  commitBtn.addEventListener('click', doCommit);

  const selKey = (mode, abs) => `${mode}\0${abs}`;
  function pruneSelection(c) {
    const live = new Set();
    if (c) {
      for (const f of c.staged) live.add(selKey('s', root + sep + f.path));
      for (const f of c.unstaged) live.add(selKey('w', root + sep + f.path));
    }
    for (const k of selected) if (!live.has(k)) selected.delete(k);
    if (selAnchor && !live.has(selAnchor)) selAnchor = null;
  }

  /** Repo-relative paths (renames include their old path) for the rows in `els`. */
  function pathsOf(els) {
    const out = new Set();
    for (const n of els) { out.add(rel(n.dataset.p)); if (n.dataset.o) out.add(n.dataset.o); }
    return [...out];
  }
  async function discardPaths(paths) {
    if (!paths.length || !root) return;
    const what = paths.length === 1 ? `changes to ${base(paths[0])}` : `changes to ${paths.length} files`;
    if (!confirm(`Discard ${what}? This can't be undone.`)) return;
    try { await H.gitDiscard(root, paths); }
    catch (e) { toast(`Discard failed: ${e.message}`); }
    refreshGit();
  }
  async function applyGit(act, paths) {
    if (!paths.length || !root) return;
    if (act === 'discard') return discardPaths(paths);
    try { await (act === 'stage' ? H.gitStage : H.gitUnstage)(root, paths); }
    catch (e) { toast(`${act === 'stage' ? 'Stage' : 'Unstage'} failed: ${e.message}`); }
    refreshGit();
  }
  /** Rows an action on `n` applies to: the whole selection when `n` is in it, else just `n`. */
  function targetRows(n) {
    const k = selKey(n.dataset.m, n.dataset.p);
    if (!selected.has(k)) return [n];
    return [...document.querySelectorAll('#changes .cn.sel')];
  }

  /** cmd/ctrl-click toggles, shift-click extends from the anchor; both stay within one of Staged/Changes. */
  function selectRow(n, e) {
    const k = selKey(n.dataset.m, n.dataset.p);
    const rows = [...document.querySelectorAll(`#changes .cn[data-m="${n.dataset.m}"]`)];
    if (e.shiftKey && selAnchor && selAnchor.startsWith(n.dataset.m + '\0')) {
      const a = rows.findIndex(r => selKey(r.dataset.m, r.dataset.p) === selAnchor), b = rows.indexOf(n);
      if (!e.metaKey && !e.ctrlKey) selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(selKey(rows[i].dataset.m, rows[i].dataset.p));
    } else {
      if ([...selected].some(x => !x.startsWith(n.dataset.m + '\0'))) selected.clear();
      selected.has(k) ? selected.delete(k) : selected.add(k);
      selAnchor = k;
    }
    renderChanges();
  }

  async function toggleCommit(sha) {
    if (openCommits.delete(sha)) return renderChanges();
    openCommits.add(sha);
    renderChanges();
    if (commitFiles.has(sha)) return;
    commitFiles.set(sha, null);
    const files = await H.gitCommitFiles(root, sha).catch(() => []);
    commitFiles.set(sha, files);
    renderChanges();
  }

  function setTreeView(v, persist = true) {
    treeView = v;
    $('#tree').hidden = v !== 'files';
    $('#changes').hidden = v !== 'changes';
    document.querySelectorAll('.tree-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    if (persist) H.saveUi({ treeView: v });
    renderChanges();
  }
  $('.tree-tabs').addEventListener('mousedown', e => e.stopPropagation()); // don't start dragging the pane
  $('.tree-tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) setTreeView(b.dataset.v); });

  $('#changes').addEventListener('click', e => {
    const act = e.target.closest('.cn-act');
    if (act) {
      e.stopPropagation();
      const row = act.closest('.cn');
      const c = changesByRoot.get(root);
      if (row) applyGit(act.dataset.act, pathsOf(targetRows(row)));
      else if (c) applyGit(act.dataset.act, pathsOf((act.dataset.act === 'unstage' ? c.staged : c.unstaged).map(f => ({ dataset: { p: root + sep + f.path, o: f.orig } }))));
      return;
    }
    const h = e.target.closest('.cn-head');
    if (h) {
      const id = h.dataset.sec;
      collapsedSecs.has(id) ? collapsedSecs.delete(id) : collapsedSecs.add(id);
      renderChanges();
      return;
    }
    const cm = e.target.closest('.cm');
    if (cm) { toggleCommit(cm.dataset.sha); return; }
    const n = e.target.closest('.cn');
    if (!n) return;
    if ((n.dataset.m === 's' || n.dataset.m === 'w') && (e.metaKey || e.ctrlKey || e.shiftKey)) return selectRow(n, e);
    if (selected.size) { selected.clear(); selAnchor = null; renderChanges(); }
    selAnchor = (n.dataset.m === 's' || n.dataset.m === 'w') ? selKey(n.dataset.m, n.dataset.p) : null;
    openDiff(n.dataset.m, n.dataset.p);
  });
  $('#changes').addEventListener('contextmenu', e => {
    const cm = e.target.closest('.cm');
    if (cm) {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [{ label: 'Copy Commit SHA', run: () => navigator.clipboard.writeText(cm.dataset.sha) }]);
      return;
    }
    const n = e.target.closest('.cn');
    if (!n) return;
    e.preventDefault();
    const rows = targetRows(n), many = rows.length > 1;
    const stageItems = n.dataset.m === 'w' ? [{ label: many ? `Stage ${rows.length} Files` : 'Stage', run: () => applyGit('stage', pathsOf(rows)) }]
      : n.dataset.m === 's' ? [{ label: many ? `Unstage ${rows.length} Files` : 'Unstage', run: () => applyGit('unstage', pathsOf(rows)) }] : [];
    showContextMenu(e.clientX, e.clientY, [
      ...stageItems,
      ...(n.dataset.s === 'D' || n.dataset.m.startsWith('c:') ? [] : [{ label: 'Open File', run: () => openFile(n.dataset.p) }]),
      { label: 'Copy Relative Path', run: () => navigator.clipboard.writeText(rel(n.dataset.p)) },
      { label: 'Send to Agent', run: () => window.harborApp && window.harborApp.sendToAgent(`@${rel(n.dataset.p)} `) },
      { label: 'Reveal in Finder', run: () => H.reveal(n.dataset.p) },
    ]);
  });

  async function renderTree() {
    const el = $('#tree');
    if (!root) { el.innerHTML = ''; return; }
    const git = gitByRoot.get(root) || {};
    const exp = expanded();
    const rows = [];
    const walk = async (dir, depth) => {
      for (const e of await listDir(dir)) {
        const r = rel(e.path);
        const code = e.type === 'dir' ? (git[r + '/'] ? '•' : '') : (git[r] || '');
        rows.push({ ...e, depth, code, open: e.type === 'dir' && exp.has(e.path) });
        if (e.type === 'dir' && exp.has(e.path)) await walk(e.path, depth + 1);
      }
    };
    await walk(root, 0);
    const active = Lay().activeFile();
    const flavor = window.harborTheme.name;
    el.innerHTML = rows.map(r => `<div class="tn ${r.type} ${r.path === active ? 'on' : ''} g${r.code === '?' ? 'u' : r.code === '•' ? 'd' : (r.code || '').toLowerCase()}" data-p="${esc(r.path)}" data-t="${r.type}" style="padding-left:${8 + r.depth * 12}px">
      <span class="tw${r.open ? ' open' : ''}">${r.type === 'dir' ? CHEVRON : ''}</span><img class="ti" src="fileicons/${flavor}/${iconFor(r.name, r.type, r.open)}.svg" draggable="false"><span class="tl">${esc(r.name)}</span>${r.code && r.code !== '•' ? `<span class="tg">${r.code === '?' ? 'U' : r.code}</span>` : r.code === '•' ? '<span class="tg dot">•</span>' : ''}</div>`).join('')
      || '<div class="tree-empty">Empty folder</div>';
  }

  $('#tree').addEventListener('click', async e => {
    const n = e.target.closest('.tn');
    if (!n) return;
    const p = n.dataset.p;
    if (n.dataset.t === 'dir') {
      const exp = expanded();
      exp.has(p) ? exp.delete(p) : exp.add(p);
      await renderTree();
      persistTree();
    } else openFile(p, { preview: true });
  });
  $('#tree').addEventListener('dblclick', e => {
    const n = e.target.closest('.tn');
    if (n && n.dataset.t !== 'dir') openFile(n.dataset.p, { pin: true });
  });
  $('#tree').addEventListener('mousedown', e => {
    const n = e.target.closest('.tn');
    if (e.button === 0 && n && n.dataset.t !== 'dir') Lay().dragFile(e, n.dataset.p, base(n.dataset.p));
  });
  $('#tree').addEventListener('contextmenu', e => {
    const n = e.target.closest('.tn');
    if (!n) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Copy Path', run: () => navigator.clipboard.writeText(n.dataset.p) },
      { label: 'Copy Relative Path', run: () => navigator.clipboard.writeText(rel(n.dataset.p)) },
      { label: 'Send to Agent', run: () => window.harborApp && window.harborApp.sendToAgent(`@${rel(n.dataset.p)} `) },
      { label: 'Reveal in Finder', run: () => H.reveal(n.dataset.p) },
    ]);
  });

  function persistTree() {
    const saved = {};
    for (const [r, s] of expandedByRoot) saved[r] = [...s].slice(0, 200);
    H.saveUi({ expanded: saved });
  }

  async function revealInTree(path) {
    if (!path || !root || !path.startsWith(root + sep)) { markTreeActive(); return; }
    const exp = expanded();
    let d = dirname(path), changed = false;
    while (d.length > root.length) { if (!exp.has(d)) { exp.add(d); changed = true; } d = dirname(d); }
    if (changed) await renderTree(); else markTreeActive();
    const n = [...document.querySelectorAll('#tree .tn')].find(x => x.dataset.p === path);
    if (n) n.scrollIntoView({ block: 'nearest' });
  }

  function markTreeActive() {
    const a = Lay().activeFile();
    document.querySelectorAll('#tree .tn.on').forEach(n => n.classList.remove('on'));
    const n = [...document.querySelectorAll('#tree .tn')].find(x => x.dataset.p === a);
    if (n) n.classList.add('on');
    if (treeView === 'changes') renderChanges();
  }

  let gitTimer;
  function refreshGit() {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(async () => {
      if (!root) return;
      const r = root;
      const [isRepo, status, changes, log, stat] = await Promise.all([
        H.gitIsRepo(r).catch(() => true),
        H.gitStatus(r).catch(() => ({})),
        H.gitChanges(r).catch(() => ({ staged: [], unstaged: [] })),
        H.gitLog(r).catch(() => []),
        H.gitDiffStat(r).catch(() => ({ add: 0, del: 0 })),
      ]);
      if (isRepo) notRepo.delete(r); else notRepo.add(r);
      statByRoot.set(r, stat);
      gitByRoot.set(r, status);
      changesByRoot.set(r, changes);
      logByRoot.set(r, log);
      if (r === root) { renderTree(); renderChanges(); refreshDiffs(r); }
    }, 200);
  }

  H.onFsChanged(async (r, paths, gitChanged) => {
    const dirs = new Set();
    let structural = false;
    for (const p of paths) {
      dirs.add(dirname(p));
      if (models.has(p)) reloadFromDisk(p);
      if (!dirCache.get(dirname(p))?.some(e => e.path === p)) structural = true;
    }
    // re-list affected directories (new/deleted files)
    for (const d of dirs) if (dirCache.has(d)) await listDir(d, true);
    if (structural) indexByRoot.delete(r);
    if (r === root) { refreshGit(); if (dirs.size) renderTree(); }
    else if (gitChanged) { gitByRoot.delete(r); changesByRoot.delete(r); logByRoot.delete(r); }
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

  function openFileResult(r) {
    const p = r.f.startsWith('/') ? r.f : `${root}/${r.f}`;
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

  // tree / editor splitter
  const treeSide = () => ($('#panes').classList.contains('tree-left') ? 'left' : 'right');
  window.harborDnd.dock($('.tree-head'), $('#panes'), {
    getSide: treeSide,
    setSide: side => { $('#panes').classList.toggle('tree-left', side === 'left'); H.saveUi({ treeSide: side }); },
  });
  (() => {
    const sp = $('#treeSplit'), pane = $('#treePane');
    sp.addEventListener('mousedown', e => {
      e.preventDefault();
      const sx = e.clientX, sw = pane.getBoundingClientRect().width;
      const dir = treeSide() === 'left' ? 1 : -1;
      const mv = ev => { pane.style.width = `${Math.max(140, Math.min(520, sw + dir * (ev.clientX - sx)))}px`; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); H.saveUi({ treeWidth: pane.style.width }); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
    });
  })();

  // ------------------------------------------------------------------ init

  function whenReady() { return ready ? Promise.resolve() : new Promise(r => readyWaiters.push(r)); }

  function defineTheme() {
    for (const t of window.harborTheme.monacoThemes()) monaco.editor.defineTheme(t.id, t.def);
    monaco.editor.setTheme(window.harborTheme.monaco().id);
    window.harborTheme.onChange(() => { monaco.editor.setTheme(window.harborTheme.monaco().id); renderTree(); renderChanges(); });
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
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => $('#app').classList.toggle('no-sidebar'));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => window.harborApp.openPalette());  // replaces Monaco's own palette
    addMoveTabKeys(ed);
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => sendSelectionToAgent());
    ed.addAction({
      id: 'harbor.sendToAgent', label: 'Send Selection to Agent', contextMenuGroupId: '9_harbor', contextMenuOrder: 1,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL],
      run: () => sendSelectionToAgent(),
    });
    return ed;
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
    if (settings.editorFontFamily) commitMsg.style.fontFamily = settings.editorFontFamily;
    commitMsg.style.fontSize = size + 'px';
    const ui = state.ui || {};
    if (ui.treeWidth) $('#treePane').style.width = ui.treeWidth;
    $('#panes').classList.toggle('tree-left', ui.treeSide === 'left');
    if (ui.treeView === 'changes') setTreeView('changes', false);
    if (ui.treeHidden) { treeVisible = false; $('#treePane').hidden = true; $('#treeSplit').hidden = true; }
    for (const [r, list] of Object.entries(ui.expanded || {})) expandedByRoot.set(r, new Set(list));
    window.MonacoEnvironment = {
      // No web workers from file:// — Monaco runs its small editor worker on the main thread instead.
      getWorker() { throw new Error('workers disabled'); },
    };
    window.require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
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

  function sendSelectionToAgent() {
    const model = editor.getModel();
    const m = metaOf(model);
    if (!m) return;
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
    window.harborApp.composeToAgent(ref);
  }

  async function setRoot(r, force) {
    if (!force && r === root) return;
    root = r;
    if (r) knownRoots.add(r);
    $('#treeTitle').textContent = r ? base(r) : '';
    if (!ready) return;
    gitByRoot.delete(r);
    refreshGit();
    renderTree();
    renderChanges();
    const open = Lay().activeFile();
    if (open) revealInTree(open);
    if (r && !indexByRoot.has(r)) H.fileIndex(r).then(f => indexByRoot.set(r, f)).catch(() => {});
  }

  window.harborEditor = {
    init, setRoot, openFile, openQuickOpen, fileIndexLoaded, loadFileIndex, fileMatches, fileRowHtml, openFileResult, showContextMenu,
    save: () => save(),
    closeTab, dropPath,
    renderTabs,
    show, preload, tabInfo, saveView, focusGroup, groupFocused, disposeGroup, revealInTree,
    layoutGroup: gid => { const ed = editors.get(gid), dd = diffs.get(gid); if (ed) ed.layout(); if (dd) dd.ed.layout(); },
    showDiff, diffInfo, closeDiff, openDiff,
    showChanges() { this.toggleTree(true); setTreeView('changes'); },
    showFiles() { this.toggleTree(true); setTreeView('files'); },
    moveTreeSide() {
      const side = treeSide() === 'left' ? 'right' : 'left';
      $('#panes').classList.toggle('tree-left', side === 'left');
      H.saveUi({ treeSide: side });
    },
    toggleRich,
    focus() {
      const gid = [...editors].find(([, e]) => e === editor);
      const rv = gid && richViews.get(gid[0]);
      if (rv && rv.path) rv.view.focus(); else if (editor) editor.focus();
    },
    toggleTree(forceShow) {
      treeVisible = forceShow ? true : !treeVisible;
      $('#treePane').hidden = !treeVisible; $('#treeSplit').hidden = !treeVisible;
      H.saveUi({ treeHidden: !treeVisible });
    },
    setLspStatus(list) { lspStatus = list || []; renderStatus(); },
    dirtyCount: r => [...models.values()].filter(m => m.root === r && isDirty(m)).length,
    forgetRoot(r) { knownRoots.delete(r); expandedByRoot.delete(r); indexByRoot.delete(r); Lay().forgetRoot(r); },
    get editor() { return editor; },
    get root() { return root; },
  };
})();
