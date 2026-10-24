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

  let editor = null;
  let root = null;                 // active worktree
  let settings = {};
  let lspStatus = [];
  const models = new Map();        // path -> meta
  const tabsByRoot = new Map();    // root -> { tabs: [path], active: path|null }
  const expandedByRoot = new Map();// root -> Set(dir)
  const dirCache = new Map();      // dir -> entries
  const gitByRoot = new Map();     // root -> { rel: code }
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
  const tabs = () => {
    if (!tabsByRoot.has(root)) tabsByRoot.set(root, { tabs: [], active: null });
    return tabsByRoot.get(root);
  };
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
    for (const r of tabsByRoot.keys()) if (p.startsWith(r + sep)) return r;
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
  const isOpenInTab = p => [...tabsByRoot.values()].some(t => t.tabs.includes(p));

  async function save(path) {
    const m = models.get(path || tabs().active);
    if (!m || !m.model) return;
    const text = m.model.getValue();
    try {
      m.mtime = await H.write(m.path, text);
      m.savedAlt = m.model.getAlternativeVersionId();
      m.conflict = false;
      if (m.lspOpen) H.lspSave(m.root, m.kind, m.uri, text);
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
      const isActive = editor && editor.getModel() === m.model;
      const vs = isActive ? editor.saveViewState() : null;
      m.model.pushEditOperations([], [{ range: m.model.getFullModelRange(), text: file.text }], () => null);
      m.savedAlt = m.model.getAlternativeVersionId();
      m.mtime = file.mtime;
      if (vs) editor.restoreViewState(vs);
    } finally { applyingDisk = false; }
    renderTabs();
  }

  // ------------------------------------------------------------------ opening / tabs

  async function openFile(path, opts = {}) {
    await whenReady();
    const r = rootFor(path);
    if (r !== root && opts.fromNav) { /* outside current worktree (e.g. a gem) — still open here */ }
    let m;
    try { m = await ensureModel(path, { lsp: true }); }
    catch (e) { toast(`Can't open ${base(path)}: ${e.message}`); return; }
    const t = tabs();
    if (!t.tabs.includes(path)) {
      const i = t.active ? t.tabs.indexOf(t.active) + 1 : t.tabs.length;
      t.tabs.splice(i, 0, path);
    }
    if (opts.recordHistory !== false) pushHistory();
    showTab(path);
    window.harborApp.showFileView();
    if (m.model && opts.selection) {
      const s = opts.selection;
      const range = s.startLineNumber ? s : new monaco.Range(s.lineNumber, s.column, s.lineNumber, s.column);
      editor.setSelection(range);
      editor.revealRangeInCenterIfOutsideViewport(range, 0);
    }
    if (opts.focus !== false) editor.focus();
    persistTabs();
    revealInTree(path);
  }

  function showTab(path) {
    const t = tabs();
    const cur = t.active && models.get(t.active);
    if (cur && cur.model && editor.getModel() === cur.model) cur.viewState = editor.saveViewState();
    t.active = path;
    const m = path && models.get(path);
    if (m && m.model) {
      editor.setModel(m.model);
      if (m.viewState) editor.restoreViewState(m.viewState);
      $('#editorEmpty').hidden = true;
      $('#editorHost').style.visibility = 'visible';
      $('#binaryNote').hidden = true;
    } else {
      editor.setModel(null);
      $('#editorHost').style.visibility = 'hidden';
      $('#binaryNote').hidden = !(m && m.binary);
      $('#editorEmpty').hidden = !!(m && m.binary);
    }
    renderTabs();
    renderStatus();
    markTreeActive();
  }

  async function closeTab(path) {
    const t = tabs();
    path = path || t.active;
    if (!path) return;
    const m = models.get(path);
    if (isDirty(m) && !confirm(`${base(path)} has unsaved changes. Close anyway?`)) return;
    const i = t.tabs.indexOf(path);
    if (i < 0) return;
    t.tabs.splice(i, 1);
    if (t.active === path) showTab(t.tabs[Math.min(i, t.tabs.length - 1)] || null);
    // drop the model once no worktree has it open
    if (m && !isOpenInTab(path)) {
      if (m.lspOpen) H.lspClose(m.root, m.kind, m.uri);
      if (m.model) m.model.dispose();
      models.delete(path);
    }
    renderTabs();
    persistTabs();
    if (t.tabs.length) window.harborApp.applyView(); else window.harborApp.showAgentView();
  }

  function renderTabs() {
    const t = tabs();
    const el = $('#fileTabs');
    const inView = !window.harborApp || window.harborApp.inFileView();
    el.innerHTML = t.tabs.map(p => {
      const m = models.get(p);
      const errs = m ? m.diags.filter(d => d.severity === 1).length : 0;
      const dirty = isDirty(m);
      return `<div class="tab ${p === t.active && inView ? 'on' : ''} ${errs ? 'has-err' : ''}" data-p="${esc(p)}" title="${esc(rel(p))}">
        <span class="tname">${esc(base(p))}</span>${m && m.conflict ? '<span class="tconf" title="Changed on disk while you had unsaved edits">!</span>' : ''}
        <span class="tclose ${dirty ? 'dirty' : ''}">${dirty ? '●' : '×'}</span></div>`;
    }).join('');
    el.querySelectorAll('.tab').forEach(tab => {
      tab.onmousedown = e => {
        if (e.button === 1) { e.preventDefault(); closeTab(tab.dataset.p); return; }
        if (e.target.classList.contains('tclose')) return;
        showTab(tab.dataset.p); window.harborApp.showFileView(); editor.focus(); persistTabs(); revealInTree(tab.dataset.p);
      };
      tab.querySelector('.tclose').onclick = e => { e.stopPropagation(); closeTab(tab.dataset.p); };
    });
    const act = el.querySelector('.tab.on');
    if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function moveTab(path, to) {
    const t = tabs();
    const i = t.tabs.indexOf(path);
    if (i < 0) return;
    t.tabs.splice(i, 1);
    t.tabs.splice(to, 0, path);
    renderTabs();
    persistTabs();
  }
  window.harborDnd.reorder($('#fileTabs'), '.tab', el => el.dataset.p, moveTab, '.tclose');

  function persistTabs() {
    const saved = {};
    for (const [r, t] of tabsByRoot) saved[r] = { tabs: t.tabs.slice(0, 30), active: t.active };
    H.saveUi({ tabs: saved });
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
    const active = tabs().active;
    el.innerHTML = rows.map(r => `<div class="tn ${r.type} ${r.path === active ? 'on' : ''} g${r.code === '?' ? 'u' : r.code === '•' ? 'd' : (r.code || '').toLowerCase()}" data-p="${esc(r.path)}" data-t="${r.type}" style="padding-left:${8 + r.depth * 12}px">
      <span class="tw">${r.type === 'dir' ? (r.open ? '▾' : '▸') : ''}</span><span class="tl">${esc(r.name)}</span>${r.code && r.code !== '•' ? `<span class="tg">${r.code === '?' ? 'U' : r.code}</span>` : r.code === '•' ? '<span class="tg dot">•</span>' : ''}</div>`).join('')
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
    } else openFile(p);
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
    const a = tabs().active;
    document.querySelectorAll('#tree .tn.on').forEach(n => n.classList.remove('on'));
    const n = [...document.querySelectorAll('#tree .tn')].find(x => x.dataset.p === a);
    if (n) n.classList.add('on');
  }

  let gitTimer;
  function refreshGit() {
    clearTimeout(gitTimer);
    gitTimer = setTimeout(async () => {
      if (!root) return;
      const r = root;
      gitByRoot.set(r, await H.gitStatus(r).catch(() => ({})));
      if (r === root) renderTree();
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
    else if (gitChanged) gitByRoot.delete(r);
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

  let qpItems = [], qpSel = 0;
  async function openQuickOpen() {
    if (!root) return;
    window.harborApp.showOverlay($('#fileQuickBack'));
    const input = $('#fileQuickInput');
    input.value = '';
    $('#fileQuickList').innerHTML = '<div class="qi muted">Indexing…</div>';
    input.focus();
    if (!indexByRoot.has(root)) indexByRoot.set(root, await H.fileIndex(root).catch(() => []));
    renderQuickOpen();
  }

  function renderQuickOpen() {
    const raw = $('#fileQuickInput').value.trim();
    const [q, line] = raw.split(':');
    const files = indexByRoot.get(root) || [];
    const t = tabs();
    let res;
    if (!q) {
      const recent = [...t.tabs].reverse().map(p => rel(p)).filter(r => files.includes(r) || true);
      res = [...new Set([...recent, ...files])].slice(0, 60).map(f => ({ f, hits: [] }));
    } else {
      res = [];
      for (const f of files) { const m = fuzzy(q.replace(/\s+/g, ''), f); if (m) res.push({ f, ...m }); }
      res.sort((a, b) => b.score - a.score);
      res = res.slice(0, 60);
    }
    qpItems = res.map(r => ({ ...r, line: Number(line) || 0 }));
    qpSel = 0;
    $('#fileQuickList').innerHTML = qpItems.map((r, i) => {
      const hit = new Set(r.hits);
      const b = r.f.lastIndexOf('/') + 1;
      const hl = (from, to) => [...r.f.slice(from, to)].map((c, j) => (hit.has(from + j) ? `<b>${esc(c)}</b>` : esc(c))).join('');
      return `<div class="qi ${i === 0 ? 'sel' : ''}" data-i="${i}"><span class="qf">${hl(b, r.f.length)}</span><span class="r">${hl(0, Math.max(0, b - 1))}</span></div>`;
    }).join('') || '<div class="qi muted">No matching files</div>';
    $('#fileQuickList').querySelectorAll('.qi[data-i]').forEach(el => el.onmousedown = e => { e.preventDefault(); pickQuickOpen(+el.dataset.i); });
  }

  function pickQuickOpen(i) {
    const r = qpItems[i];
    window.harborApp.hideOverlay($('#fileQuickBack'));
    if (!r) return;
    const p = r.f.startsWith('/') ? r.f : `${root}/${r.f}`;
    openFile(p, r.line ? { selection: { lineNumber: r.line, column: 1 } } : {});
  }

  $('#fileQuickInput').addEventListener('input', renderQuickOpen);
  $('#fileQuickInput').addEventListener('keydown', e => {
    const move = d => {
      qpSel = Math.max(0, Math.min(qpItems.length - 1, qpSel + d));
      $('#fileQuickList').querySelectorAll('.qi').forEach((el, i) => el.classList.toggle('sel', i === qpSel));
      $('#fileQuickList').querySelector('.qi.sel')?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { move(1); e.preventDefault(); }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) { move(-1); e.preventDefault(); }
    else if (e.key === 'Enter') pickQuickOpen(qpSel);
    else if (e.key === 'Escape') { window.harborApp.hideOverlay($('#fileQuickBack')); editor && editor.focus(); }
  });
  $('#fileQuickBack').addEventListener('mousedown', e => { if (e.target.id === 'fileQuickBack') window.harborApp.hideOverlay($('#fileQuickBack')); });

  // ------------------------------------------------------------------ status bar

  function renderStatus() {
    const el = $('#edStatus');
    if (!el) return;
    const m = editor && editor.getModel() ? metaOf(editor.getModel()) : models.get(tabs().active);
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
  const treeSide = () => ($('#editorArea').classList.contains('tree-left') ? 'left' : 'right');
  window.harborDnd.dock($('.tree-head'), $('#editorArea'), {
    getSide: treeSide,
    setSide: side => { $('#editorArea').classList.toggle('tree-left', side === 'left'); H.saveUi({ treeSide: side }); },
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
    monaco.editor.defineTheme('harbor', {
      base: 'vs-dark', inherit: true,
      rules: [
        { token: 'comment', foreground: '6b737e', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'c49bf5' },
        { token: 'string', foreground: '9bd88a' },
        { token: 'number', foreground: 'f2b36e' },
        { token: 'type', foreground: '6ec7d4' },
        { token: 'type.identifier', foreground: '6ec7d4' },
        { token: 'delimiter', foreground: '9aa2ad' },
        { token: 'tag', foreground: 'f2706b' },
        { token: 'attribute.name', foreground: 'e5b454' },
        { token: 'constant', foreground: 'f2b36e' },
        { token: 'variable', foreground: 'd7dae0' },
      ],
      colors: {
        'editor.background': '#14161b', 'editor.foreground': '#d7dae0',
        'editorLineNumber.foreground': '#3f4652', 'editorLineNumber.activeForeground': '#9aa2ad',
        'editor.lineHighlightBackground': '#1b1e25', 'editor.lineHighlightBorder': '#00000000',
        'editor.selectionBackground': '#2d4a7a', 'editor.inactiveSelectionBackground': '#25324a',
        'editorCursor.foreground': '#6ea8fe', 'editorIndentGuide.background1': '#22262e', 'editorIndentGuide.activeBackground1': '#353b47',
        'editorWidget.background': '#1b1e24', 'editorWidget.border': '#303540', 'editorSuggestWidget.background': '#1b1e24',
        'editorSuggestWidget.selectedBackground': '#25324a', 'editorHoverWidget.background': '#1b1e24', 'editorHoverWidget.border': '#303540',
        'scrollbarSlider.background': '#2a2e3780', 'scrollbarSlider.hoverBackground': '#353b4799',
        'minimap.background': '#14161b', 'editorGutter.background': '#14161b',
        'peekView.border': '#6ea8fe', 'peekViewEditor.background': '#16191f', 'peekViewResult.background': '#1b1e24', 'peekViewTitle.background': '#1b1e24',
      },
    });
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

  function init(state) {
    settings = state.settings || {};
    const ui = state.ui || {};
    if (ui.treeWidth) $('#treePane').style.width = ui.treeWidth;
    $('#editorArea').classList.toggle('tree-left', ui.treeSide === 'left');
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
      editor = monaco.editor.create($('#editorHost'), {
        model: null, theme: 'harbor', automaticLayout: true,
        fontFamily: settings.editorFontFamily || '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
        fontSize: settings.editorFontSize || 13, lineHeight: Math.round((settings.editorFontSize || 13) * 1.6),
        minimap: { enabled: true, renderCharacters: false, maxColumn: 80, scale: 1 },
        scrollBeyondLastLine: false, smoothScrolling: true, cursorBlinking: 'smooth', cursorSmoothCaretAnimation: 'on',
        bracketPairColorization: { enabled: true }, guides: { bracketPairs: 'active', indentation: true },
        padding: { top: 8 }, fixedOverflowWidgets: true, renderWhitespace: 'selection', stickyScroll: { enabled: true },
        tabSize: 2, detectIndentation: true, wordBasedSuggestions: 'off', quickSuggestions: { other: true, comments: false, strings: true },
        'semanticHighlighting.enabled': false, inlayHints: { enabled: 'off' }, links: true, mouseWheelZoom: false,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      });
      registerProviders();
      editor.onDidChangeCursorPosition(() => renderStatus());
      // back / forward (VS Code bindings)
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Minus, () => goHistory(-1));
      editor.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => goHistory(1));
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => sendSelectionToAgent());
      editor.addAction({
        id: 'harbor.sendToAgent', label: 'Send Selection to Agent', contextMenuGroupId: '9_harbor', contextMenuOrder: 1,
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL],
        run: () => sendSelectionToAgent(),
      });
      // restore tabs per worktree
      for (const [r, t] of Object.entries(ui.tabs || {})) tabsByRoot.set(r, { tabs: t.tabs || [], active: t.active || null, restoring: true });
      ready = true;
      readyWaiters.splice(0).forEach(f => f());
      if (root) setRoot(root, true);
    });
  }

  function sendSelectionToAgent() {
    const model = editor.getModel();
    const m = metaOf(model);
    if (!m) return;
    const s = editor.getSelection();
    let ref = `@${rel(m.path)}`;
    if (s && !s.isEmpty()) {
      const a = s.startLineNumber, b = s.endColumn === 1 && s.endLineNumber > a ? s.endLineNumber - 1 : s.endLineNumber;
      ref += a === b ? `#L${a}` : `#L${a}-${b}`;
    }
    window.harborApp.sendToAgent(ref + ' ');
  }

  async function setRoot(r, force) {
    if (!force && r === root) return;
    if (editor && editor.getModel()) {
      const cur = metaOf(editor.getModel());
      if (cur) cur.viewState = editor.saveViewState();
    }
    root = r;
    $('#treeTitle').textContent = r ? base(r) : '';
    if (!ready) return;
    const t = tabs();
    if (t.restoring) {
      t.restoring = false;
      const want = t.active;
      const valid = [];
      for (const p of t.tabs) { try { await ensureModel(p, { lsp: true }); valid.push(p); } catch { /* file gone */ } }
      t.tabs = valid;
      t.active = valid.includes(want) ? want : valid[0] || null;
    }
    showTab(t.active);
    gitByRoot.delete(r);
    refreshGit();
    renderTree();
    if (t.active) revealInTree(t.active);
    if (!indexByRoot.has(r)) H.fileIndex(r).then(f => indexByRoot.set(r, f)).catch(() => {});
  }

  window.harborEditor = {
    init, setRoot, openFile, openQuickOpen,
    save: () => save(),
    closeTab: () => closeTab(),
    renderTabs,
    activePath: () => (root ? tabs().active : null),
    focus: () => editor && editor.focus(),
    toggleTree(forceShow) {
      treeVisible = forceShow ? true : !treeVisible;
      $('#treePane').hidden = !treeVisible; $('#treeSplit').hidden = !treeVisible;
      H.saveUi({ treeHidden: !treeVisible });
    },
    setLspStatus(list) { lspStatus = list || []; renderStatus(); },
    dirtyCount: r => [...models.values()].filter(m => m.root === r && isDirty(m)).length,
    forgetRoot(r) { tabsByRoot.delete(r); expandedByRoot.delete(r); indexByRoot.delete(r); persistTabs(); },
    get editor() { return editor; },
  };
})();
