// Tawny editor: Monaco + language servers (via main process), tabs, file tree, ⌘P file search.
import type * as Monaco from 'monaco-editor';
import type { LspInfo } from '../../../shared/types';
import { alertDialog, confirmDialog } from '../lib/dialog';
import { iconSrc } from '../lib/fileicons';
import { H } from '../lib/legacy';
import { theme } from '../lib/theme';

// Monaco is loaded at runtime by the AMD loader (vs/loader.js) and lands on the global scope.
declare const monaco: typeof Monaco;

// biome-ignore lint/suspicious/noExplicitAny: LSP payloads and the Tiptap view are loosely typed
type Any = any;
type Ed = Monaco.editor.IStandaloneCodeEditor;
type DiffEd = Monaco.editor.IStandaloneDiffEditor;
type Model = Monaco.editor.ITextModel;
type Pos = { lineNumber: number; column: number };
type Selection = { startLineNumber?: number; lineNumber: number; column: number };

interface LspPos {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPos;
  end: LspPos;
}
interface Diag {
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
  range: LspRange;
  tags?: number[];
}
interface Meta {
  path: string;
  model: Model | null;
  root: string | null;
  binary: boolean;
  mtime: number;
  savedAlt: number;
  kind: string | null;
  uri: string | null;
  version: number;
  syncKind: number;
  lspOpen: boolean;
  lspPending?: boolean;
  lspError?: string;
  conflict: boolean;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  diags: Diag[];
  bgSave?: ReturnType<typeof setTimeout>;
}
interface DiffState {
  ed: DiffEd;
  inline: boolean;
  shown: boolean;
  key: string | null;
  mode: string | null;
  path: string | null;
  root: string | null;
  owned: Model[];
}
interface RichState {
  view: Any;
  path: string | null;
  text: string | null;
  syncing: boolean;
}
interface ParsedDiff {
  mode: string;
  path: string;
  sha?: string;
  n?: string;
}
export interface FileMatch {
  f: string;
  hits?: number[];
  score?: number;
  line?: number;
}
interface OpenOpts {
  focus?: boolean;
  preview?: boolean;
  pin?: boolean;
  recordHistory?: boolean;
  selection?: Selection | Monaco.IRange;
}
type LspStatus = LspInfo;
interface Settings {
  editorFontSize?: number;
  editorFontFamily?: string;
  richMarkdown?: boolean;
}
type MenuItem = { label: string; run?(): void; sub?: MenuItem[]; color?: string };

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
const sep = '/';
const base = (p: string) => p.split(sep).pop() as string;
const dirname = (p: string) => p.slice(0, p.lastIndexOf(sep)) || sep;

const Lay = () => window.harborLayout;
const editors = new Map<string, Ed>(); // group id -> monaco editor (one per tab group)
const hosts = new Map<string, { host: HTMLElement; pill: HTMLElement }>(); // group id -> { host, pill } (the editor's container and its Source/Rich switch)
const asks = new WeakMap<Ed, { focus(): boolean }>(); // monaco editor -> { focus() } for its selection message box
const richViews = new Map<string, RichState>(); // group id -> { view (Tiptap, window.harborRich), path, text, syncing } while created
const richOverride = new Map<string, boolean>(); // markdown path -> true/false once toggled; otherwise settings.richMarkdown decides (default: rich)
let editor: Ed | null = null; // the editor of the focused group
let root: string | null = null; // active worktree
let settings: Settings = {};
let lspStatus: LspStatus[] = [];
const models = new Map<string, Meta>(); // path -> meta
const knownRoots = new Set<string>();
const diffs = new Map<string, DiffState>(); // group id -> { ed (diff editor), shown, key, mode, path, root, owned: [in-memory models] }
const indexByRoot = new Map<string, string[]>(); // root -> [rel]
const pendingDiags = new Map<string, Diag[]>(); // path -> lsp diagnostics
const history: { path: string; line: number; col: number }[] = []; // [{path, line, col}] for go back
let historyPos = -1;
let ready = false;
const readyWaiters: (() => void)[] = [];

// ------------------------------------------------------------------ helpers

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  ru: 'ruby',
  jbuilder: 'ruby',
  erb: 'html',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  ini: 'ini',
  toml: 'ini',
  env: 'ini',
};
const RUBY_NAMES = new Set(['Gemfile', 'Rakefile', 'Guardfile', 'Capfile', 'Brewfile', 'Podfile', 'Fastfile']);
function languageFor(p: string) {
  const b = base(p);
  if (RUBY_NAMES.has(b)) return 'ruby';
  if (b === 'Dockerfile') return 'dockerfile';
  if (b.startsWith('.env')) return 'ini';
  const ext = b.includes('.') ? (b.split('.').pop() as string).toLowerCase() : '';
  return LANG_BY_EXT[ext] || 'plaintext';
}

function uriToPath(u: string) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'file:') return null;
    return decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
}
const toLspPos = (p: Pos) => ({ line: p.lineNumber - 1, character: p.column - 1 });
const toRange = (r: LspRange) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toLspRange = (r: Monaco.IRange) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});
const metaOf = (model: Model | null | undefined) => (model ? models.get(model.uri.path) : undefined);
const rel = (p: string) => (root && p.startsWith(root + sep) ? p.slice(root.length + 1) : p);

function markdown(c: Any): Monaco.IMarkdownString[] {
  if (!c) return [];
  if (Array.isArray(c)) return c.flatMap(markdown);
  if (typeof c === 'string') return c ? [{ value: c }] : [];
  if (c.kind === 'plaintext') return [{ value: `\`\`\`text\n${c.value}\n\`\`\`` }];
  if (c.kind === 'markdown') return [{ value: c.value, isTrusted: false, supportHtml: false }];
  if (c.language !== undefined) return [{ value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` }];
  return [];
}
const docString = (d: Any) =>
  !d ? undefined : typeof d === 'string' ? d : d.kind === 'markdown' ? { value: d.value } : d.value;

async function req(model: Model, method: string, params: Record<string, unknown> = {}) {
  const m = metaOf(model);
  if (!m?.kind || !m.lspOpen) return null;
  try {
    return await H.lspRequest(m.root as string, m.kind, method, { textDocument: { uri: m.uri }, ...params });
  } catch {
    return null;
  }
}

type DocSym = Monaco.languages.DocumentSymbol;
function toDocSymbols(r: Any[] | null): DocSym[] {
  const conv = (s: Any): DocSym => {
    const range = toRange(s.range || s.location.range);
    return {
      name: s.name,
      detail: s.detail || '',
      kind: Math.max(0, (s.kind || 1) - 1),
      tags: [],
      range,
      selectionRange: s.selectionRange ? toRange(s.selectionRange) : range,
      children: (s.children || []).map(conv),
    };
  };
  return (r || []).map(conv);
}

// ------------------------------------------------------------------ models

async function ensureModel(path: string, { lsp = false } = {}): Promise<Meta> {
  let m = models.get(path);
  if (!m) {
    const file = await H.read(path);
    const model = file.binary ? null : monaco.editor.createModel(file.text, languageFor(path), monaco.Uri.file(path));
    const created: Meta = {
      path,
      model,
      root: rootFor(path),
      binary: file.binary,
      mtime: file.mtime,
      savedAlt: model ? model.getAlternativeVersionId() : 0,
      kind: null,
      uri: null,
      version: 1,
      syncKind: 2,
      lspOpen: false,
      conflict: false,
      viewState: null,
      diags: [],
    };
    m = created;
    models.set(path, created);
    if (model) {
      window.harborDebug.modelCreated(path, model);
      model.onDidChangeContent((e) => onModelChange(created as Meta & { model: Model }, e));
      const pd = pendingDiags.get(path);
      if (pd) {
        setDiagnostics(created, pd);
        pendingDiags.delete(path);
      }
    }
  }
  if (lsp && m.model && !m.lspOpen && !m.lspPending) await openLsp(m as Meta & { model: Model });
  return m;
}

function rootFor(p: string) {
  if (root && (p === root || p.startsWith(root + sep))) return root;
  for (const r of knownRoots) if (p.startsWith(r + sep)) return r;
  return root;
}

async function openLsp(m: Meta & { model: Model }) {
  m.lspPending = true;
  try {
    const res = await H.lspOpen(m.root as string, m.path, m.model.getValue());
    if (res && !res.error) {
      Object.assign(m, { kind: res.kind, uri: res.uri, syncKind: res.syncKind, version: 1, lspOpen: true });
    } else if (res?.error) {
      m.kind = res.kind;
      m.lspOpen = false;
      m.lspError = res.error;
    }
  } catch (e) {
    m.lspError = (e as Error).message;
  } finally {
    m.lspPending = false;
    renderStatus();
  }
}

let applyingDisk = false;
function onModelChange(m: Meta & { model: Model }, e: Monaco.editor.IModelContentChangedEvent) {
  for (const rv of richViews.values()) {
    if (rv.path === m.path && !rv.syncing) {
      rv.text = m.model.getValue();
      rv.view.setMarkdown(rv.text);
    }
  }
  if (m.lspOpen) {
    m.version++;
    const changes =
      m.syncKind === 2
        ? e.changes.map((c) => ({ range: toLspRange(c.range), rangeLength: c.rangeLength, text: c.text }))
        : [{ text: m.model.getValue() }];
    H.lspChange(m.root as string, m.kind as string, m.uri as string, m.version, changes);
  }
  // models without a tab (e.g. touched by a rename across files) are saved straight away
  if (!applyingDisk && !isOpenInTab(m.path)) {
    clearTimeout(m.bgSave);
    m.bgSave = setTimeout(() => save(m.path), 50);
  }
  renderTabs();
}

const isDirty = (m: Meta | null | undefined) => !!m?.model && m.model.getAlternativeVersionId() !== m.savedAlt;
const isOpenInTab = (p: string) => Lay().hasFile(p);

async function save(path?: string) {
  const m = models.get(path || Lay().activeFile() || parseDiff(Lay().activeKey())?.path || '');
  const model = m?.model;
  if (!m || !model) return;
  const text = model.getValue();
  try {
    m.mtime = await H.write(m.path, text);
    m.savedAlt = model.getAlternativeVersionId();
    m.conflict = false;
    if (m.lspOpen) H.lspSave(m.root as string, m.kind as string, m.uri as string, text);
    window.harborDebug.saved(m.path);
    renderTabs();
    refreshGit();
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`);
  }
}

/** File changed on disk (agent edits): reload clean buffers in place, flag dirty ones. */
async function reloadFromDisk(path: string) {
  const m = models.get(path);
  if (!m?.model) return;
  let file: Any;
  try {
    file = await H.read(path);
  } catch {
    return;
  } // deleted: keep buffer
  if (file.binary) return;
  const cur = m.model.getValue();
  if (file.text === cur) {
    m.mtime = file.mtime;
    return;
  }
  if (isDirty(m)) {
    m.conflict = true;
    renderTabs();
    return;
  }
  applyingDisk = true;
  try {
    const shown = [...editors.values()].filter((ed) => ed.getModel() === m.model);
    const states = shown.map((ed) => ed.saveViewState());
    m.model.pushEditOperations([], [{ range: m.model.getFullModelRange(), text: file.text }], () => null);
    m.savedAlt = m.model.getAlternativeVersionId();
    m.mtime = file.mtime;
    for (const [i, ed] of shown.entries()) ed.restoreViewState(states[i]);
  } finally {
    applyingDisk = false;
  }
  renderTabs();
}

// ------------------------------------------------------------------ opening / tabs

async function openFile(path: string, opts: OpenOpts = {}) {
  await whenReady();
  if (opts.recordHistory !== false) pushHistory();
  const gid = await Lay().openFile(path, { focus: opts.focus !== false, preview: !!opts.preview, pin: !!opts.pin });
  if (!gid) return;
  const ed = editors.get(gid);
  const m = models.get(path);
  if (ed && m?.model && opts.selection) {
    const s = opts.selection as Any;
    const range = s.startLineNumber ? s : new monaco.Range(s.lineNumber, s.column, s.lineNumber, s.column);
    ed.setSelection(range);
    ed.revealRangeInCenterIfOutsideViewport(range, 0);
  }
  if (opts.focus !== false && ed) ed.focus();
  revealInTree(path);
}

/** Put `path` into the editor of group `gid` (creating the editor in `host` on first use). */
const showTok = new Map();
async function show(
  gid: string,
  host: HTMLElement,
  path: string,
): Promise<(Meta & { error?: undefined }) | { error: true; model?: undefined; binary?: undefined }> {
  await whenReady();
  const tok = (showTok.get(gid) || 0) + 1;
  showTok.set(gid, tok);
  const dd = diffs.get(gid);
  if (dd?.shown) releaseDiff(dd);
  const ed = editors.get(gid) || createEditor(gid, host);
  if (Lay().focusedGroup() === gid) editor = ed;
  const prev = ed.getModel() && metaOf(ed.getModel());
  if (prev) prev.viewState = ed.saveViewState();
  let m: Meta;
  try {
    m = await ensureModel(path, { lsp: true });
  } catch (e) {
    toast(`Can't open ${base(path)}: ${(e as Error).message}`);
    return { error: true };
  }
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

const isRichable = (p: string) => /\.(md|markdown)$/i.test(p);
const wantsRich = (p: string) => (richOverride.has(p) ? !!richOverride.get(p) : settings.richMarkdown !== false);

function syncRich(gid: string, path: string | null) {
  const h = hosts.get(gid);
  if (!h) return;
  const m = path ? models.get(path) : undefined;
  const able = !!(m?.model && path && isRichable(path));
  const on = able && !!path && wantsRich(path);
  h.pill.hidden = !able;
  h.pill.querySelector('[data-m=rich]')?.classList.toggle('on', on);
  h.pill.querySelector('[data-m=source]')?.classList.toggle('on', !on);
  let rv = richViews.get(gid);
  if (!on) {
    if (rv) {
      rv.view.el.hidden = true;
      rv.path = null;
    }
    return;
  }
  if (!rv) {
    const state: RichState = { path: null, text: null, syncing: false, view: null };
    rv = state;
    state.view = (window as Any).harborRich.create(h.host, {
      onChange: (md: string) => {
        const mm = models.get(state.path as string);
        if (!mm?.model) return;
        state.syncing = true;
        try {
          mm.model.pushEditOperations([], [{ range: mm.model.getFullModelRange(), text: md }], () => null);
        } finally {
          state.syncing = false;
        }
        state.text = mm.model.getValue();
      },
      onLink: (href: string) => {
        if (/^https?:/i.test(href)) {
          window.open(href);
          return;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return;
        const target = decodeURIComponent(new URL(href, `file://${dirname(state.path as string)}/`).pathname);
        if (target !== state.path) openFile(target);
      },
      onSelectionMenu: (x: number, y: number) =>
        showContextMenu(x, y, [
          { label: 'Send Selection to Agent', run: () => sendSelectionToAgent() },
          { label: 'Copy', run: () => document.execCommand('copy') },
        ]),
      ask: {
        targets: () => window.harborApp.sendTargets(),
        send: (msg: string, id?: string) => {
          const ref = selectionRef();
          if (ref) window.harborApp.askAgent(ref, msg, id);
        },
      },
      keys: {
        'Mod-b': () => window.harborApp.toggleSidebar(),
        'Mod-Alt-l': () => sendSelectionToAgent(),
        'Mod-Alt-Shift-ArrowLeft': () => Lay().moveActive(-1),
        'Mod-Alt-Shift-ArrowRight': () => Lay().moveActive(1),
        'Mod-Alt-Shift-ArrowUp': () => Lay().moveActive('up'),
        'Mod-Alt-Shift-ArrowDown': () => Lay().moveActive('down'),
      },
    });
    state.view.el.addEventListener('focusin', () => {
      editor = editors.get(gid) || editor;
      Lay().focusGroup(gid);
    });
    richViews.set(gid, state);
  }
  const text = (m as Meta & { model: Model }).model.getValue();
  rv.view.setBaseDir(dirname(path as string));
  if (rv.path !== path || rv.text !== text) {
    rv.view.setMarkdown(text, { reset: rv.path !== path });
    rv.text = text;
  }
  rv.path = path;
  rv.view.el.hidden = false;
}

function setRich(path: string, on: boolean) {
  richOverride.set(path, on);
  for (const [gid, ed] of editors) {
    const mm = metaOf(ed.getModel());
    if (mm && mm.path === path) syncRich(gid, path);
  }
  const gid = Lay().focusedGroup();
  if (gid) focusGroup(gid);
}

function toggleRich() {
  const p = Lay().activeFile();
  if (!p || !isRichable(p)) {
    toast('Rich view is for markdown files');
    return;
  }
  setRich(p, !wantsRich(p));
}

/** Ensure models (and language servers) exist for restored tabs; resolves with the paths that are gone. */
async function preload(paths: string[]) {
  await whenReady();
  const missing: string[] = [];
  for (const p of paths) {
    try {
      await ensureModel(p, { lsp: true });
    } catch {
      missing.push(p);
    }
  }
  return missing;
}

async function closeTab(pathArg?: string) {
  const path = pathArg || Lay().activeFile();
  if (!path) return;
  const m = models.get(path);
  if (
    isDirty(m) &&
    !(await confirmDialog({
      title: 'Unsaved changes',
      message: `${base(path)} has unsaved changes. Close anyway?`,
      confirmLabel: 'Close anyway',
      danger: true,
    }))
  )
    return;
  Lay().removeFile(path);
  // drop the model once no worktree has it open
  if (m && !isOpenInTab(path)) {
    freeModel(m, path);
  }
}

/** Free the model of a tab replaced in place, unless it is open elsewhere. */
function dropPath(path: string) {
  const m = models.get(path);
  if (m && !isOpenInTab(path)) freeModel(m, path);
}

function freeModel(m: Meta, path: string) {
  if (m.lspOpen) H.lspClose(m.root as string, m.kind as string, m.uri as string);
  if (m.model) {
    releaseDiffsUsing(m.model);
    m.model.dispose();
  }
  richOverride.delete(path);
  for (const rv of richViews.values())
    if (rv.path === path) {
      rv.view.el.hidden = true;
      rv.path = null;
    }
  models.delete(path);
}

const renderTabs = () => Lay().renderTabs();

function tabInfo(path: string) {
  const m = models.get(path);
  return {
    name: base(path),
    title: rel(path),
    dirty: !!isDirty(m),
    conflict: !!m?.conflict,
    errs: m ? m.diags.filter((d) => d.severity === 1).length : 0,
  };
}

function saveView(gid: string, path: string) {
  const ed = editors.get(gid);
  const m = models.get(path);
  if (ed && m?.model && ed.getModel() === m.model) m.viewState = ed.saveViewState();
}

function focusGroup(gid: string) {
  let tries = 0;
  const go = () => {
    const rv = richViews.get(gid);
    if (rv?.path) {
      rv.view.focus();
      return;
    }
    const dd = diffs.get(gid);
    const ed = dd?.shown ? dd.ed.getModifiedEditor() : editors.get(gid);
    if (ed?.getModel()) ed.focus();
    else if (tries++ < 20) setTimeout(go, 50);
  };
  go();
}

function groupFocused(gid: string) {
  const dd = diffs.get(gid);
  const ed = dd?.shown ? dd.ed.getModifiedEditor() : editors.get(gid);
  if (ed) editor = ed;
  renderStatus();
  markTreeActive();
}

function disposeGroup(gid: string) {
  const dd = diffs.get(gid);
  if (dd) {
    const mod = dd.ed.getModifiedEditor();
    releaseDiff(dd);
    if (editor === mod) editor = null;
    dd.ed.dispose();
    diffs.delete(gid);
  }
  const rv = richViews.get(gid);
  if (rv) {
    rv.view.destroy();
    richViews.delete(gid);
  }
  hosts.delete(gid);
  const ed = editors.get(gid);
  if (!ed) return;
  const m = metaOf(ed.getModel());
  if (m) m.viewState = ed.saveViewState();
  editors.delete(gid);
  showTok.delete(gid);
  if (editor === ed) editor = null;
  ed.dispose();
}

// ------------------------------------------------------------------ diff tabs
// 'd:s:<path>' = staged (HEAD ↔ index, read-only), 'd:w:<path>' = unstaged (index ↔ working tree, editable),
// 'd:c:<sha>:<path>' = a commit (parent ↔ commit, read-only), 'd:t:<n>:<path>' = texts held in memory (an agent's edit, read-only).
const textDiffs = new Map<string, { oldText: string; newText: string }>(); // key -> { oldText, newText }; gone after a restart, which closes the tab
let textDiffSeq = 0;

function parseDiff(key: string | null | undefined): ParsedDiff | null {
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
const relIn = (r: string, p: string) => (p.startsWith(r + sep) ? p.slice(r.length + 1) : p);
let gitUriSeq = 0;
// never a file: URI, so metaOf() finds no language-server state for these models
const gitUri = (ref: string, path: string) =>
  monaco.Uri.from({ scheme: 'harbor-git', path: `/${ref}${path}`, query: String(++gitUriSeq) });

function diffInfo(key: string) {
  const d = parseDiff(key);
  if (!d) return { name: key, title: key, dirty: false };
  if (d.mode === 'c') {
    const sh = (d.sha as string).slice(0, 7);
    return { name: `${base(d.path)} (${sh})`, title: `${rel(d.path)} — ${sh}^ ↔ ${sh}`, dirty: false };
  }
  if (d.mode === 't')
    return { name: `${base(d.path)} (Agent edit)`, title: `${rel(d.path)} — before ↔ after`, dirty: false };
  const staged = d.mode === 's';
  return {
    name: `${base(d.path)} (${staged ? 'Index' : 'Working Tree'})`,
    title: `${rel(d.path)} — ${staged ? 'HEAD ↔ Index' : 'Index ↔ Working Tree'}`,
    dirty: !staged && !!isDirty(models.get(d.path)),
  };
}

/** Original/modified text from git for a diff tab ({ orig, mod } — mod only for staged and commit diffs). */
async function diffSides(r: string, mode: string, path: string, sha?: string): Promise<{ orig: Any; mod: Any }> {
  const rl = relIn(r, path);
  if (mode === 'c') {
    const ch = Tree()
      .commitFiles(sha as string)
      .find((x) => x.path === rl);
    const [orig, mod] = await Promise.all([H.gitShow(r, ch?.orig || rl, `${sha}^`), H.gitShow(r, rl, sha as string)]);
    return { orig, mod };
  }
  const c = Tree().changes(r);
  const ch = c && (mode === 's' ? c.staged : c.unstaged).find((x) => x.path === rl);
  const orig = await H.gitShow(r, ch?.orig || rl, mode === 's' ? 'HEAD' : 'index');
  const mod = mode === 's' ? await H.gitShow(r, rl, 'index') : null;
  return { orig, mod };
}

function createDiff(gid: string, host: HTMLElement) {
  const size = settings.editorFontSize || 13;
  const ed = monaco.editor.createDiffEditor(host, {
    theme: theme.monaco().id,
    automaticLayout: true,
    fontFamily: settings.editorFontFamily || '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
    fontSize: size,
    lineHeight: Math.round(size * 1.6),
    renderSideBySide: true,
    renderSideBySideInlineBreakpoint: 700,
    stickyScroll: { enabled: false },
    originalEditable: false,
    ignoreTrimWhitespace: false,
    enableSplitViewResizing: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    padding: { top: 8 },
    fixedOverflowWidgets: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  });
  const dd: DiffState = { ed, inline: false, shown: false, key: null, mode: null, path: null, root: null, owned: [] };
  diffs.set(gid, dd);
  const mod = ed.getModifiedEditor();
  for (const side of [mod, ed.getOriginalEditor()]) {
    side.onDidFocusEditorWidget(() => {
      editor = mod;
      Lay().focusGroup(gid);
    });
    side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => window.harborApp.toggleSidebar());
    side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () =>
      window.harborApp.openPalette(),
    );
    addMoveTabKeys(side);
    side.addCommand(monaco.KeyCode.F7, () => ed.goToDiff('next'));
    side.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => ed.goToDiff('previous'));
  }
  // the diff goes inline on its own in narrow panes; this pins either layout
  mod.addAction({
    id: 'harbor.toggleInlineDiff',
    label: 'Toggle Inline View',
    contextMenuGroupId: '9_harbor',
    contextMenuOrder: 2,
    run: () => {
      dd.inline = !dd.inline;
      ed.updateOptions({ renderSideBySide: !dd.inline, useInlineViewWhenSpaceIsLimited: false });
    },
  });
  return dd;
}

/** Detach the models from a diff editor and free the ones we created for it. */
function releaseDiff(dd: DiffState) {
  dd.shown = false;
  dd.key = null;
  dd.ed.setModel(null);
  for (const m of dd.owned.splice(0)) m.dispose();
}
function releaseDiffsUsing(model: Model) {
  for (const dd of diffs.values()) {
    const cur = dd.ed.getModel();
    if (cur && (cur.modified === model || cur.original === model)) releaseDiff(dd);
  }
}

async function showDiff(
  gid: string,
  host: HTMLElement,
  key: string,
): Promise<{ error?: true; model?: true; binary?: true }> {
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
    for (const m of old) m.dispose();
    Object.assign(dd, { owned: [original, modified], shown: true, key, mode: 't', path: d.path, root: r });
    dd.ed.getModifiedEditor().updateOptions({ readOnly: true });
    if (Lay().focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
    renderStatus();
    return { model: true };
  }
  let sides: { orig: Any; mod: Any };
  let meta: Meta | null = null;
  try {
    sides = await diffSides(r as string, d.mode, d.path, d.sha);
    if (d.mode === 'w') {
      try {
        meta = await ensureModel(d.path);
      } catch {
        meta = null;
      }
    } // deleted files have no model
  } catch (e) {
    toast(`Can't diff ${base(d.path)}: ${(e as Error).message}`);
    return { error: true };
  }
  if (showTok.get(gid) !== tok) return {};
  if (sides.orig.binary || sides.mod?.binary || (meta && !meta.model)) {
    releaseDiff(dd);
    return { binary: true };
  }
  const lang = languageFor(d.path);
  const oref = d.mode === 'c' ? `${(d.sha as string).slice(0, 7)}^` : d.mode === 's' ? 'HEAD' : 'index';
  const original = monaco.editor.createModel(sides.orig.text, lang, gitUri(oref, d.path));
  const owned = [original];
  let modified: Model;
  if (meta) modified = meta.model as Model;
  else {
    modified = monaco.editor.createModel(
      sides.mod ? sides.mod.text : '',
      lang,
      gitUri(d.mode === 'c' ? (d.sha as string).slice(0, 7) : d.mode === 's' ? 'index' : 'worktree', d.path),
    );
    owned.push(modified);
  }
  const old = dd.owned.splice(0);
  dd.ed.setModel({ original, modified });
  for (const m of old) m.dispose();
  Object.assign(dd, { owned, shown: true, key, mode: d.mode, path: d.path, root: r });
  dd.ed.getModifiedEditor().updateOptions({ readOnly: d.mode !== 'w' || !meta });
  if (Lay().focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
  renderStatus();
  return { model: true };
}

/** Re-read the git side(s) of every visible diff after the index / HEAD moved. */
async function refreshDiffs(r: string) {
  for (const dd of [...diffs.values()]) {
    if (!dd.shown || dd.root !== r || dd.mode === 'c' || dd.mode === 't') continue; // commits never change
    const key = dd.key;
    let sides: { orig: Any; mod: Any };
    try {
      sides = await diffSides(r, dd.mode as string, dd.path as string);
    } catch {
      continue;
    }
    if (!dd.shown || dd.key !== key || sides.orig.binary) continue;
    const cur = dd.ed.getModel();
    if (!cur) continue;
    if (cur.original.getValue() !== sides.orig.text) cur.original.setValue(sides.orig.text);
    if (dd.mode === 's' && sides.mod && !sides.mod.binary && cur.modified.getValue() !== sides.mod.text)
      cur.modified.setValue(sides.mod.text);
  }
}

/** Diff of two texts that aren't in git (an agent's edit from a chat tab). */
async function openTextDiff(path: string, oldText: unknown, newText: unknown) {
  const key = `d:t:${++textDiffSeq}:${path}`;
  textDiffs.set(key, {
    oldText: oldText == null ? '' : String(oldText),
    newText: newText == null ? '' : String(newText),
  });
  await whenReady();
  const gid = await Lay().openKey(key, { pin: true });
  if (gid) focusGroup(gid);
}

async function openDiff(mode: string, path: string, opts: OpenOpts = {}) {
  await whenReady();
  const gid = await Lay().openDiff(mode, path, opts);
  if (gid) focusGroup(gid);
}

/** Free the model of a diff tab replaced in place, unless a file tab still has it. */
function dropDiff(key: string) {
  const d = parseDiff(key);
  const m = d?.mode === 'w' ? models.get(d.path) : null;
  if (d && m && !isOpenInTab(d.path)) freeModel(m, d.path);
}

async function closeDiff(key: string) {
  const d = parseDiff(key);
  if (!d) return;
  const m = d.mode === 'w' ? models.get(d.path) : null;
  if (
    isDirty(m) &&
    !Lay().hasKey(`f:${d.path}`) &&
    !(await confirmDialog({
      title: 'Unsaved changes',
      message: `${base(d.path)} has unsaved changes. Close anyway?`,
      confirmLabel: 'Close anyway',
      danger: true,
    }))
  )
    return;
  Lay().removeKey(key);
  textDiffs.delete(key);
  if (m && !isOpenInTab(d.path)) freeModel(m, d.path);
}

// ------------------------------------------------------------------ navigation history

function pushHistory() {
  if (!editor?.getModel()) return;
  const m = metaOf(editor.getModel());
  if (!m) return;
  const p = editor.getPosition() as Pos;
  history.splice(historyPos + 1);
  history.push({ path: m.path, line: p.lineNumber, col: p.column });
  if (history.length > 100) history.shift();
  historyPos = history.length - 1;
}
function goHistory(dir: number) {
  if (dir < 0 && historyPos === history.length - 1) {
    pushHistory();
    historyPos--;
  }
  const i = historyPos + dir;
  const h = history[i];
  if (!h) return;
  historyPos = i;
  openFile(h.path, { selection: { lineNumber: h.line, column: h.col }, recordHistory: false });
}

// ------------------------------------------------------------------ diagnostics

const SEV = () => ({
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
});
function setDiagnostics(m: Meta, diags: Diag[]) {
  m.diags = diags;
  if (!m.model) return;
  const sev = SEV() as Record<number, Monaco.MarkerSeverity>;
  monaco.editor.setModelMarkers(
    m.model,
    'lsp',
    diags.map((d) => ({
      severity: sev[d.severity || 1] as Monaco.MarkerSeverity,
      message: d.message,
      source: d.source,
      code: d.code !== undefined ? String(d.code) : undefined,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
      tags: (d.tags || []).map((t) => (t === 1 ? monaco.MarkerTag.Unnecessary : monaco.MarkerTag.Deprecated)),
    })),
  );
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

function editsByFile(edit: Any) {
  const out = new Map<string, Any[]>();
  const add = (uri: string, edits: Any[]) => {
    const p = uriToPath(uri);
    if (!p) return;
    if (!out.has(p)) out.set(p, []);
    out.get(p)?.push(...edits);
  };
  if (edit.changes) for (const [uri, edits] of Object.entries<Any[]>(edit.changes)) add(uri, edits);
  if (edit.documentChanges)
    for (const dc of edit.documentChanges) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
  return out;
}

async function applyWorkspaceEdit(edit: Any) {
  for (const [path, edits] of editsByFile(edit)) {
    const m = models.get(path);
    if (m?.model) {
      m.model.pushEditOperations(
        [],
        edits.map((e) => ({ range: toRange(e.range), text: e.newText })),
        () => null,
      );
    } else {
      try {
        await H.applyEditsToDisk(path, edits);
      } catch (e) {
        toast(`Edit failed for ${base(path)}: ${(e as Error).message}`);
      }
    }
  }
}
H.onApplyEdit((_root, e) => applyWorkspaceEdit(e));

async function toMonacoWorkspaceEdit(edit: Any) {
  const result: { edits: Monaco.languages.IWorkspaceTextEdit[] } = { edits: [] };
  for (const [path, edits] of editsByFile(edit)) {
    await ensureModel(path).catch(() => null);
    for (const e of edits)
      result.edits.push({
        resource: monaco.Uri.file(path),
        textEdit: { range: toRange(e.range), text: e.newText },
        versionId: undefined,
      });
  }
  return result;
}

// ------------------------------------------------------------------ LSP → Monaco providers

const KIND_NAMES: (string | null)[] = [
  null,
  'Text',
  'Method',
  'Function',
  'Constructor',
  'Field',
  'Variable',
  'Class',
  'Interface',
  'Module',
  'Property',
  'Unit',
  'Value',
  'Enum',
  'Keyword',
  'Snippet',
  'Color',
  'File',
  'Reference',
  'Folder',
  'EnumMember',
  'Constant',
  'Struct',
  'Event',
  'Operator',
  'TypeParameter',
];

async function toLocations(res: Any) {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  const out: Monaco.languages.Location[] = [];
  for (const l of arr) {
    const uri = l.targetUri || l.uri;
    const range = l.targetSelectionRange || l.targetRange || l.range;
    const p = uriToPath(uri);
    if (!p || !range) continue;
    try {
      await ensureModel(p);
    } catch {
      continue;
    }
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
        if (!m?.lspOpen) return { suggestions: [] };
        const res = await req(model, 'textDocument/completion', {
          position: toLspPos(position),
          context:
            ctx.triggerKind === 1 && ctx.triggerCharacter
              ? { triggerKind: 2, triggerCharacter: ctx.triggerCharacter }
              : { triggerKind: ctx.triggerKind === 2 ? 3 : 1 },
        });
        if (!res) return { suggestions: [] };
        const items = Array.isArray(res) ? res : res.items || [];
        const word = model.getWordUntilPosition(position);
        const def = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, position.column);
        const suggestions = items.slice(0, 1000).map((it: Any) => {
          const te = it.textEdit;
          let range: Any = def;
          let insertText = it.insertText ?? (typeof it.label === 'string' ? it.label : it.label.label);
          if (te) {
            insertText = te.newText;
            range = te.range ? toRange(te.range) : { insert: toRange(te.insert), replace: toRange(te.replace) };
          }
          return {
            label: it.labelDetails
              ? { label: it.label, detail: it.labelDetails.detail, description: it.labelDetails.description }
              : it.label,
            kind: (L.CompletionItemKind as Any)[KIND_NAMES[it.kind] || 'Text'] ?? L.CompletionItemKind.Text,
            detail: it.detail,
            documentation: docString(it.documentation),
            sortText: it.sortText,
            filterText: it.filterText,
            preselect: it.preselect,
            insertText,
            range,
            insertTextRules: it.insertTextFormat === 2 ? L.CompletionItemInsertTextRule.InsertAsSnippet : 0,
            additionalTextEdits: (it.additionalTextEdits || []).map((e: Any) => ({
              range: toRange(e.range),
              text: e.newText,
            })),
            commitCharacters: it.commitCharacters,
            tags: it.deprecated || (it.tags || []).includes(1) ? [L.CompletionItemTag.Deprecated] : [],
            _lsp: it,
            _meta: m,
          };
        });
        return { suggestions, incomplete: !Array.isArray(res) && !!res.isIncomplete };
      },
      async resolveCompletionItem(item: Any) {
        const m = item._meta as Meta | undefined;
        if (!m?.lspOpen || item.documentation) return item;
        try {
          const r = await H.lspRequest(m.root as string, m.kind as string, 'completionItem/resolve', item._lsp);
          if (r) {
            item.documentation = docString(r.documentation) || item.documentation;
            item.detail = r.detail || item.detail;
            if (r.additionalTextEdits)
              item.additionalTextEdits = r.additionalTextEdits.map((e: Any) => ({
                range: toRange(e.range),
                text: e.newText,
              }));
          }
        } catch {
          /* not supported */
        }
        return item;
      },
    });

    L.registerHoverProvider(lang, {
      async provideHover(model, position) {
        const r = await req(model, 'textDocument/hover', { position: toLspPos(position) });
        if (!r?.contents) return null;
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
      async provideTypeDefinition(model, position) {
        return toLocations(await req(model, 'textDocument/typeDefinition', { position: toLspPos(position) }));
      },
    });
    L.registerImplementationProvider(lang, {
      async provideImplementation(model, position) {
        return toLocations(await req(model, 'textDocument/implementation', { position: toLspPos(position) }));
      },
    });
    L.registerReferenceProvider(lang, {
      async provideReferences(model, position, ctx) {
        return toLocations(
          await req(model, 'textDocument/references', {
            position: toLspPos(position),
            context: { includeDeclaration: ctx.includeDeclaration },
          }),
        );
      },
    });

    L.registerSignatureHelpProvider(lang, {
      signatureHelpTriggerCharacters: ['(', ','],
      signatureHelpRetriggerCharacters: [')'],
      async provideSignatureHelp(model, position) {
        const r = await req(model, 'textDocument/signatureHelp', { position: toLspPos(position) });
        if (!r?.signatures?.length) return null;
        return {
          value: {
            signatures: r.signatures.map((s: Any) => ({
              label: s.label,
              documentation: docString(s.documentation),
              parameters: (s.parameters || []).map((p: Any) => ({
                label: p.label,
                documentation: docString(p.documentation),
              })),
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
        return (r || []).map((h: Any) => ({ range: toRange(h.range), kind: (h.kind || 1) - 1 }));
      },
    });

    L.registerDocumentSymbolProvider(lang, {
      displayName: 'LSP',
      async provideDocumentSymbols(model) {
        const r = await req(model, 'textDocument/documentSymbol');
        return toDocSymbols(r);
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
        const r = await req(model, 'textDocument/formatting', {
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
        });
        return (r || []).map((e: Any) => ({ range: toRange(e.range), text: e.newText }));
      },
    });

    L.registerCodeActionProvider(lang, {
      async provideCodeActions(model, range, ctx) {
        const m = metaOf(model);
        if (!m?.lspOpen) return { actions: [], dispose() {} };
        const diags = m.diags.filter((d) => toRange(d.range).intersectRanges(range));
        const r = await req(model, 'textDocument/codeAction', {
          range: toLspRange(range),
          context: {
            diagnostics: diags,
            only: ctx.only ? [ctx.only] : undefined,
            triggerKind: ctx.trigger === 1 ? 1 : 2,
          },
        });
        const actions: Any[] = [];
        for (const a of r || []) {
          if (a.command && typeof a.command === 'string') {
            // bare Command
            actions.push({
              title: a.title,
              command: { id: 'harbor.lsp.exec', title: a.title, arguments: [m.root, m.kind, a] },
            });
            continue;
          }
          const act: Any = {
            title: a.title,
            kind: a.kind,
            isPreferred: a.isPreferred,
            diagnostics: [],
            _lsp: a,
            _meta: m,
          };
          if (a.edit) act.edit = await toMonacoWorkspaceEdit(a.edit);
          if (a.command)
            act.command = { id: 'harbor.lsp.exec', title: a.command.title, arguments: [m.root, m.kind, a.command] };
          actions.push(act);
        }
        return { actions, dispose() {} };
      },
      async resolveCodeAction(action: Any) {
        if (action.edit || !action._lsp || !action._meta) return action;
        try {
          const r = await H.lspRequest(
            action._meta.root as string,
            action._meta.kind as string,
            'codeAction/resolve',
            action._lsp,
          );
          if (r?.edit) action.edit = await toMonacoWorkspaceEdit(r.edit);
        } catch {
          /* */
        }
        return action;
      },
    });
  }

  monaco.editor.registerCommand('harbor.lsp.exec', (_acc, r, kind, cmd) =>
    H.lspRequest(r, kind, 'workspace/executeCommand', { command: cmd.command, arguments: cmd.arguments }).catch(
      () => {},
    ),
  );

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
        openFile(uri.path.replace(/\/{2,}/g, '/'), {
          selection: mm ? { lineNumber: +mm[1], column: +(mm[2] || 1) } : undefined,
        });
        return true;
      },
    });
  }
}

// ------------------------------------------------------------------ file tree (React: components/tree)

const Tree = () => window.harborTree;
const refreshGit = () => Tree().refreshGit();
const revealInTree = (path: string) => Tree().revealInTree(path);
const markTreeActive = () => Tree().markActive();

H.onFsChanged((_r: string, paths: string[]) => {
  for (const p of paths) if (models.has(p)) reloadFromDisk(p);
});

// ------------------------------------------------------------------ ⌘P

function fuzzy(q: string, s: string) {
  // subsequence match with bonuses for consecutive chars and basename hits
  q = q.toLowerCase();
  const sl = s.toLowerCase();
  const b = sl.lastIndexOf('/') + 1;
  let qi = 0,
    score = 0,
    last = -2;
  const hits: number[] = [];
  for (let i = 0; i < sl.length && qi < q.length; i++) {
    if (sl[i] === q[qi]) {
      score +=
        (i === last + 1 ? 5 : 1) +
        (i >= b ? 3 : 0) +
        (i === b || s[i - 1] === '/' || s[i - 1] === '_' || s[i - 1] === '-' || s[i - 1] === '.' ? 4 : 0);
      hits.push(i);
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= s.length * 0.02;
  if (sl.slice(b).startsWith(q)) score += 15;
  return { score, hits };
}

// file mode of the command palette (app.js): empty input = go to file, '>' prefix = commands
const openQuickOpen = () => root && window.harborApp.openPalette('');
const fileIndexLoaded = () => !!root && indexByRoot.has(root);
async function loadFileIndex() {
  const r = root;
  if (r && !indexByRoot.has(r)) indexByRoot.set(r, await H.fileIndex(r).catch(() => []));
}

function fileMatches(raw: string): (FileMatch & { hits: number[]; line: number })[] {
  const [q, line] = raw.trim().split(':');
  const files = (root && indexByRoot.get(root)) || [];
  let res: (FileMatch & { hits: number[] })[];
  if (!q) {
    const recent = Lay()
      .filesOf(root as string)
      .reverse()
      .map((p) => rel(p));
    res = [...new Set([...recent, ...files])].slice(0, 60).map((f) => ({ f, hits: [] }));
  } else {
    res = [];
    for (const f of files) {
      const m = fuzzy(q.replace(/\s+/g, ''), f);
      if (m) res.push({ f, ...m });
    }
    res.sort((a, b) => (b.score || 0) - (a.score || 0));
    res = res.slice(0, 60);
  }
  return res.map((r) => ({ ...r, line: Number(line) || 0 }));
}

function fileRowHtml(r: FileMatch) {
  const hit = new Set(r.hits || []);
  const b = r.f.lastIndexOf('/') + 1;
  const hl = (from: number, to: number) =>
    [...r.f.slice(from, to)].map((c, j) => (hit.has(from + j) ? `<b>${esc(c)}</b>` : esc(c))).join('');
  return `<span class="qf">${hl(b, r.f.length)}</span><span class="r">${hl(0, Math.max(0, b - 1))}</span>`;
}

const absPath = (f: string) => (f.startsWith('/') ? f : `${root}/${f}`);

/** Syntax-highlighted lines (HTML) of `text` as `path`'s language, or null when too long or unavailable. */
async function colorizeLines(text: string, path: string) {
  await whenReady();
  if (text.length > 60000) return null;
  try {
    return (await monaco.editor.colorize(text, languageFor(path), { tabSize: 2 })).split(/<br\s*\/?>/);
  } catch {
    return null;
  }
}

/** Unsaved text of an open file, or null when it isn't open or has no unsaved changes (for `fs/read_text_file`). */
function dirtyText(path: string) {
  const m = models.get(path);
  return m?.model && isDirty(m) ? m.model.getValue() : null;
}

function openFileResult(r: FileMatch) {
  const p = absPath(r.f);
  return openFile(p, r.line ? { selection: { lineNumber: r.line, column: 1 } } : {});
}

// ------------------------------------------------------------------ status bar

function renderStatus() {
  const el = $('#edStatus');
  if (!el) return;
  el.hidden = !Lay().activeFile();
  if (el.hidden) return;
  const m = editor?.getModel() ? metaOf(editor.getModel()) : models.get(Lay().activeFile() as string);
  const parts = [];
  let lspHtml = '';
  if (m?.kind) {
    const st = lspStatus.find((s) => s.root === m.root && s.kind === m.kind);
    if (st) {
      if (st.state === 'error') {
        lspHtml =
          `<span class="lsp err" title="${esc(st.error)}">⚠ ${esc(st.name)} not running</span>` +
          (st.installable ? '<button class="sbtn" data-act="installRuby">Install ruby-lsp</button>' : '') +
          '<button class="sbtn" data-act="lspRestart">Retry</button><button class="sbtn" data-act="lspDetails">Details</button>';
      } else if (st.state === 'starting')
        lspHtml = `<span class="lsp busy"><i class="mini-spin"></i>${esc(st.name)} starting…</span>`;
      else if (st.progress) lspHtml = `<span class="lsp busy"><i class="mini-spin"></i>${esc(st.progress)}</span>`;
      else lspHtml = `<span class="lsp ok">● ${esc(st.name)}</span>`;
    }
  } else if (m?.model) lspHtml = '<span class="lsp off">No language server</span>';
  parts.push(lspHtml);
  if (m?.model) {
    const errs = m.diags.filter((d) => d.severity === 1).length;
    const warns = m.diags.filter((d) => d.severity === 2).length;
    parts.push(`<span class="probs" data-act="problems" title="Next problem (F8)">⊗ ${errs} ⚠ ${warns}</span>`);
  }
  const pos = editor?.getModel() ? editor.getPosition() : null;
  el.innerHTML = `<div class="sl">${parts.join('')}</div><div class="sr">${m?.conflict ? '<span class="lsp err">File changed on disk — save to overwrite or close to discard</span>' : ''}${pos ? `<span>Ln ${pos.lineNumber}, Col ${pos.column}</span>` : ''}${m?.model ? `<span>${esc(m.model.getLanguageId())}</span>` : ''}</div>`;
}

$('#edStatus').addEventListener('click', async (e) => {
  const target = e.target as HTMLButtonElement;
  const act = target.dataset.act;
  const m = editor?.getModel() ? metaOf(editor.getModel()) : null;
  if (!act || !m || !editor) return;
  if (act === 'lspRestart') {
    await H.lspRestart(m.root as string, m.kind as string);
  } else if (act === 'lspDetails') {
    const st = lspStatus.find((s) => s.root === m.root && s.kind === m.kind);
    void alertDialog(st?.error ?? 'No details');
  } else if (act === 'installRuby') {
    target.textContent = 'Installing…';
    target.disabled = true;
    try {
      await H.lspInstallRuby(m.root as string);
      toast('ruby-lsp installed');
    } catch (err) {
      void alertDialog(`gem install ruby-lsp failed:\n\n${(err as Error).message}`);
    }
  } else if (act === 'problems') {
    editor.focus();
    editor.trigger('harbor', 'editor.action.marker.next', null);
  }
});

H.onLspRestarted(async (r: string, kind: string) => {
  for (const m of models.values()) {
    if (m.root === r && m.kind === kind && m.model && isOpenInTab(m.path)) {
      m.lspOpen = false;
      await openLsp(m as Meta & { model: Model });
    }
  }
});

// ------------------------------------------------------------------ misc UI

function toast(msg: string) {
  window.harborApp?.toast(msg);
}

function showContextMenu(x: number, y: number, items: MenuItem[]) {
  const menuEl = $('#ctxMenu');
  let subEl: HTMLElement | null = null;
  const rows = (list: MenuItem[]) =>
    list
      .map((it, i) => {
        const dot = it.color ? `<span class="cdot" style="background:${it.color}"></span>` : '';
        return `<div class="ci${it.sub ? ' has-sub' : ''}" data-i="${i}">${dot}${esc(it.label)}</div>`;
      })
      .join('');
  const place = (el: HTMLElement, px: number, py: number) => {
    el.style.left = `${Math.max(6, Math.min(px, innerWidth - el.offsetWidth - 6))}px`;
    el.style.top = `${Math.max(6, Math.min(py, innerHeight - el.offsetHeight - 6))}px`;
  };
  const close = () => {
    menuEl.hidden = true;
    closeSub();
    document.removeEventListener('mousedown', outside, true);
  };
  const closeSub = () => {
    subEl?.remove();
    subEl = null;
  };
  const outside = (ev: MouseEvent) => {
    const t = ev.target as Node;
    if (!menuEl.contains(t) && !subEl?.contains(t)) close();
  };
  const openSub = (row: HTMLElement, sub: MenuItem[]) => {
    closeSub();
    const el = document.createElement('div');
    el.id = 'ctxSub';
    el.innerHTML = rows(sub);
    document.body.appendChild(el);
    const r = row.getBoundingClientRect();
    const mr = menuEl.getBoundingClientRect();
    place(el, r.right + 2 + el.offsetWidth > innerWidth ? mr.left - el.offsetWidth - 2 : mr.right + 2, r.top - 5);
    for (const c of el.querySelectorAll<HTMLElement>('.ci'))
      c.onclick = () => {
        close();
        sub[Number(c.dataset.i)].run?.();
      };
    subEl = el;
  };
  menuEl.innerHTML = rows(items);
  menuEl.hidden = false;
  place(menuEl, x, y);
  document.addEventListener('mousedown', outside, true);
  for (const el of menuEl.querySelectorAll<HTMLElement>('.ci')) {
    const it = items[Number(el.dataset.i)];
    el.onmouseenter = () => (it.sub ? openSub(el, it.sub) : closeSub());
    el.onclick = () => {
      if (it.sub) return openSub(el, it.sub);
      close();
      it.run?.();
    };
  }
}

// ------------------------------------------------------------------ init

function whenReady(): Promise<void> {
  return ready
    ? Promise.resolve()
    : new Promise<void>((r) => {
        readyWaiters.push(r);
      });
}

function defineTheme() {
  for (const t of theme.monacoThemes()) monaco.editor.defineTheme(t.id, t.def);
  monaco.editor.setTheme(theme.monaco().id);
  theme.onChange(() => {
    monaco.editor.setTheme(theme.monaco().id);
  });
}

function disableBuiltinTs() {
  const ts = (monaco.languages as Any).typescript || (monaco as Any).typescript;
  if (!ts) return;
  const off = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    documentRangeFormattingEdits: false,
    signatureHelp: false,
    onTypeFormattingEdits: false,
    codeActions: false,
    inlayHints: false,
  };
  for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
    if (!d) continue;
    try {
      d.setModeConfiguration(off);
    } catch {
      /* old api */
    }
    try {
      d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, noSuggestionDiagnostics: true });
    } catch {
      /* */
    }
  }
}

function createEditor(gid: string, host: HTMLElement) {
  const mon = document.createElement('div');
  mon.className = 'ed-mon';
  host.append(mon);
  const ed = monaco.editor.create(mon, {
    model: null,
    theme: theme.monaco().id,
    automaticLayout: true,
    fontFamily: settings.editorFontFamily || '"SF Mono", Menlo, Monaco, "JetBrains Mono", monospace',
    fontSize: settings.editorFontSize || 13,
    lineHeight: Math.round((settings.editorFontSize || 13) * 1.6),
    minimap: { enabled: false },
    glyphMargin: true,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    padding: { top: 8 },
    fixedOverflowWidgets: true,
    renderWhitespace: 'selection',
    stickyScroll: { enabled: true },
    tabSize: 2,
    detectIndentation: true,
    wordBasedSuggestions: 'off',
    quickSuggestions: { other: true, comments: false, strings: true },
    'semanticHighlighting.enabled': false,
    inlayHints: { enabled: 'off' },
    links: true,
    mouseWheelZoom: false,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  });
  editors.set(gid, ed);
  window.harborDebug.attach(ed);
  const pill = document.createElement('div');
  pill.className = 'rich-toggle';
  pill.hidden = true;
  pill.innerHTML = '<button data-m="source">Source</button><button data-m="rich">Rich</button>';
  pill.addEventListener('mousedown', (e) => e.preventDefault());
  pill.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    const mm = metaOf(ed.getModel());
    if (b && mm) setRich(mm.path, b.dataset.m === 'rich');
  });
  host.append(pill);
  hosts.set(gid, { host, pill });
  mountCrumbs(ed, host);
  if (!editor) editor = ed;
  ed.onDidChangeCursorPosition(() => {
    if (ed === editor) renderStatus();
  });
  ed.onDidFocusEditorWidget(() => {
    editor = ed;
    Lay().focusGroup(gid);
  });
  // back / forward (VS Code bindings)
  ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Minus, () => goHistory(-1));
  ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => goHistory(1));
  // Chromium's rich-text ToggleBold swallows ⌘B in the editor before the menu accelerator fires
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => window.harborApp.toggleSidebar());
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () =>
    window.harborApp.openPalette(),
  ); // replaces Monaco's own palette
  addMoveTabKeys(ed);
  asks.set(ed, codeAsk(ed));
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => sendSelectionToAgent());
  ed.addAction({
    id: 'harbor.sendToAgent',
    label: 'Send Selection to Agent',
    contextMenuGroupId: '9_harbor',
    contextMenuOrder: 1,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL],
    run: () => sendSelectionToAgent(),
  });
  return ed;
}

const lspListeners = new Set<() => void>(); // breadcrumb bars re-ask for symbols when a language server changes state

/** Breadcrumb bar above the editor: the file's path inside the worktree, then the symbols around the cursor (LSP document symbols).
 *  Clicking a symbol lists its siblings; picking one jumps there. */
function mountCrumbs(ed: Ed, host: HTMLElement) {
  const bar = document.createElement('div');
  bar.className = 'crumbs';
  host.prepend(bar);
  let syms: DocSym[] = [];
  let symModel: Model | null = null;
  let tok = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let menu: HTMLElement | null = null;

  const closeMenu = () => {
    menu?.remove();
    menu = null;
  };
  const contains = (s: DocSym, pos: Monaco.Position) => monaco.Range.containsPosition(s.range, pos);
  const chain = (pos: Monaco.Position) => {
    const out: { sym: DocSym; siblings: DocSym[] }[] = [];
    let level = syms;
    for (;;) {
      const s = level.find((x) => contains(x, pos));
      if (!s) break;
      out.push({ sym: s, siblings: level });
      level = s.children || [];
    }
    return out;
  };
  const jump = (s: DocSym) => {
    pushHistory();
    const at = { lineNumber: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn };
    ed.setPosition(at);
    ed.revealPositionInCenterIfOutsideViewport(at);
    ed.focus();
  };
  type Item = { label: string; icon?: string; on?: boolean; run: () => void };
  const icon = (src: string) => {
    const i = document.createElement('img');
    i.className = 'ti';
    i.src = src;
    i.draggable = false;
    return i;
  };
  const showMenu = (anchor: HTMLElement, items: Item[]) => {
    closeMenu();
    const m = document.createElement('div');
    m.className = 'crumb-menu';
    for (const it of items) {
      const b = document.createElement('button');
      if (it.icon) b.append(icon(it.icon));
      b.append(it.label);
      b.classList.toggle('on', !!it.on);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', it.run);
      m.append(b);
    }
    const r = anchor.getBoundingClientRect();
    m.style.left = `${r.left}px`;
    m.style.top = `${r.bottom + 2}px`;
    document.body.append(m);
    menu = m;
    m.querySelector('.on')?.scrollIntoView({ block: 'center' });
    const off = (e: MouseEvent) => {
      if (m.contains(e.target as Node)) return;
      closeMenu();
      document.removeEventListener('mousedown', off, true);
    };
    document.addEventListener('mousedown', off, true);
  };
  const openMenu = (anchor: HTMLElement, siblings: DocSym[], cur: DocSym) =>
    showMenu(
      anchor,
      siblings.map((s) => ({
        label: s.name,
        on: s === cur,
        run: () => {
          closeMenu();
          jump(s);
        },
      })),
    );
  /** Entries of `dir` (folders first); folders open in place, files open in the editor. `cur` is highlighted. */
  const openDirMenu = async (anchor: HTMLElement, dir: string, cur: string) => {
    let ents: { name: string; path: string; type: string }[] = [];
    try {
      ents = await H.list(dir);
    } catch {
      /* unreadable folder: empty menu */
    }
    ents = [...ents].sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));
    showMenu(
      anchor,
      ents.map((e) => ({
        label: e.name,
        icon: iconSrc(e.name, e.type === 'dir' ? 'dir' : 'file'),
        on: e.path === cur,
        run: () => {
          if (e.type === 'dir') openDirMenu(anchor, e.path, '');
          else {
            closeMenu();
            openFile(e.path);
          }
        },
      })),
    );
  };

  const render = () => {
    closeMenu();
    const model = ed.getModel();
    const meta = model && metaOf(model);
    bar.hidden = !meta;
    if (!meta) return;
    bar.textContent = '';
    const add = (label: string, cls: string) => {
      if (bar.childElementCount) {
        const sp = document.createElement('i');
        sp.textContent = '›';
        bar.append(sp);
      }
      const el = document.createElement('span');
      el.className = cls;
      el.textContent = label;
      bar.append(el);
      return el;
    };
    const inRoot = !!root && meta.path.startsWith(root + sep);
    const rel = inRoot ? meta.path.slice((root as string).length + 1) : meta.path;
    const parts = rel.split(sep).filter(Boolean);
    let acc = inRoot ? (root as string) : '';
    parts.forEach((p, i) => {
      const parent = acc || sep;
      acc = acc + sep + p;
      const full = acc;
      const isFile = i === parts.length - 1;
      const el = add(p, isFile ? 'crumb file sym' : 'crumb sym');
      el.prepend(icon(iconSrc(p, isFile ? 'file' : 'dir')));
      el.addEventListener('click', () => openDirMenu(el, parent, full));
    });
    const pos = ed.getPosition();
    if (symModel !== model || !pos) return;
    for (const { sym, siblings } of chain(pos)) {
      const el = add(sym.name, 'crumb sym');
      el.addEventListener('click', () => openMenu(el, siblings, sym));
    }
    bar.scrollLeft = bar.scrollWidth;
  };

  const fetchSyms = async () => {
    const model = ed.getModel();
    if (!model) return;
    const my = ++tok;
    const r = await req(model, 'textDocument/documentSymbol');
    if (my !== tok || ed.getModel() !== model) return;
    syms = toDocSymbols(r);
    symModel = model;
    render();
  };
  const refetch = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(fetchSyms, delay);
  };

  ed.onDidChangeModel(() => {
    syms = [];
    symModel = null;
    render();
    refetch(0);
  });
  ed.onDidChangeModelContent(() => refetch(400));
  ed.onDidChangeCursorPosition(render);
  // LSP finishes starting after the model is shown: retry on status changes
  ed.onDidChangeModelLanguage(() => refetch(0));
  lspListeners.add(() => refetch(300));
}

/** Message box in a view zone just below the selection's last line: the code below is pushed down rather than covered, so all of it stays visible.
 *  focus() opens it and returns true, or false when nothing is selected. Cmd+enter sends, escape closes, shift+tab cycles agents. */
function codeAsk(ed: Ed) {
  const dom = document.createElement('div');
  dom.className = 'rich-ask';
  dom.innerHTML =
    '<textarea rows="2" placeholder="Message agent about this selection…" spellcheck="false"></textarea>' +
    '<div class="ask-foot"><span class="ask-agent" hidden><i class="sdot"></i><span></span></span>' +
    '<button type="button" class="ask-send">Send <kbd>⌘↵</kbd></button></div>';
  const ta = dom.querySelector('textarea') as HTMLTextAreaElement;
  const chip = dom.querySelector('.ask-agent') as HTMLElement;
  const dot = chip.firstChild as HTMLElement;
  const name = chip.lastChild as HTMLElement;
  const zoneDom = document.createElement('div');
  zoneDom.className = 'ask-zone';
  zoneDom.append(dom);
  let agents: { id: string; label: string; working: boolean; waiting: boolean }[] = [];
  let idx = 0;
  let zoneId: string | null = null;
  let zone: Monaco.editor.IViewZone | null = null;
  const shown = () => zoneId !== null;
  const fit = () => {
    if (!shown()) return;
    if (zone) zone.heightInPx = dom.offsetHeight + 12;
    ed.changeViewZones((a) => a.layoutZone(zoneId as string));
  };
  const renderAgent = () => {
    const a = agents[idx];
    chip.hidden = !a;
    if (!a) return;
    name.textContent = a.label;
    dot.className = `sdot${a.waiting ? ' wait' : a.working ? ' work' : ''}`;
    chip.title = agents.length > 1 ? 'shift+tab: next agent' : '';
  };
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    fit();
  };
  const hide = () => {
    if (!shown()) return;
    const id = zoneId;
    zoneId = null;
    ed.changeViewZones((a) => a.removeZone(id as string));
  };
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
  dom.querySelector('.ask-send')?.addEventListener('click', submit);
  dom.addEventListener('mousedown', (e) => {
    if (e.target !== ta) e.preventDefault();
  }); // keep focus where it is
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      if (agents.length > 1) {
        idx = (idx + 1) % agents.length;
        renderAgent();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      ed.focus();
    }
  });
  ta.addEventListener('focusout', (e) => {
    if (!dom.contains(e.relatedTarget as Node | null)) hide();
  });
  ed.onDidChangeCursorSelection(() => {
    if (!dom.contains(document.activeElement)) hide();
  }); // back to editing: drop the box
  ed.onDidChangeModel(hide);
  return {
    focus() {
      const s = ed.getSelection();
      if (!s || s.isEmpty()) return false;
      if (!shown()) {
        ({ agents, index: idx } = window.harborApp.sendTargets());
        renderAgent();
        const last = s.endColumn === 1 && s.endLineNumber > s.startLineNumber ? s.endLineNumber - 1 : s.endLineNumber; // as in selectionRef
        const z = { afterLineNumber: last, heightInPx: 110, domNode: zoneDom, suppressMouseDown: true };
        zone = z;
        ed.changeViewZones((a) => {
          zoneId = a.addZone(z);
        });
        ed.revealLineInCenterIfOutsideViewport(last);
      }
      requestAnimationFrame(() => {
        if (shown()) {
          fit();
          ta.focus();
        }
      }); // the zone is laid out on Monaco's next render
      return true;
    },
  };
}

/** Monaco claims cmd+opt+shift+arrows (cursors, copy line) before the menu accelerators fire. */
function addMoveTabKeys(ed: Monaco.editor.IStandaloneCodeEditor) {
  const m = monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyMod.Shift;
  const keys: [Monaco.KeyCode, number | 'up' | 'down'][] = [
    [monaco.KeyCode.LeftArrow, -1],
    [monaco.KeyCode.RightArrow, 1],
    [monaco.KeyCode.UpArrow, 'up'],
    [monaco.KeyCode.DownArrow, 'down'],
  ];
  for (const [code, dir] of keys) {
    ed.addCommand(m | code, () => Lay().moveActive(dir));
  }
}

function init(state: Any) {
  settings = state.settings || {};
  const ui = state.ui || {};
  window.MonacoEnvironment = {
    // No web workers from file:// — Monaco runs its small editor worker on the main thread instead.
    getWorker() {
      throw new Error('workers disabled');
    },
  };
  const amd = (window as Any).require;
  amd.config({ paths: { vs: './monaco/vs' } });
  amd(['vs/editor/editor.main'], () => {
    defineTheme();
    disableBuiltinTs();
    registerProviders();
    window.harborDebug.init(ui);
    ready = true;
    for (const f of readyWaiters.splice(0)) f();
    if (root) setRoot(root, true);
  });
}

/** "@file#L3-5" for the focused editor's selection (the whole file when nothing is selected); null without a file. */
function selectionRef() {
  if (!editor) return null;
  const model = editor.getModel() as Model;
  const m = metaOf(model);
  if (!m) return null;
  let a: number | undefined;
  let b: number | undefined;
  const gid = [...editors].find(([, e]) => e === editor)?.[0];
  const rv = gid && richViews.get(gid);
  if (rv && rv.path === m.path && !rv.view.el.hidden) {
    // rich view on top: its selection is mapped back onto the markdown source
    const r = rv.view.selectionLines(model.getValue());
    if (r) [a, b] = r;
  } else {
    const s = editor.getSelection();
    if (s && !s.isEmpty()) {
      a = s.startLineNumber;
      b = s.endColumn === 1 && s.endLineNumber > a ? s.endLineNumber - 1 : s.endLineNumber;
    }
  }
  let ref = `@${rel(m.path)}`;
  if (a) ref += a === b ? `#L${a}` : `#L${a}-${b}`;
  return ref;
}

function sendSelectionToAgent() {
  if (!editor) return;
  const m = metaOf(editor.getModel());
  const gid = [...editors].find(([, e]) => e === editor)?.[0];
  const rv = gid && richViews.get(gid);
  if (m && rv && rv.path === m.path && !rv.view.el.hidden && rv.view.focusAsk()) return; // rich view: type into the box over the selection
  if (asks.get(editor)?.focus()) return; // code editor: type into the box beside the selection
  const ref = selectionRef();
  if (ref) window.harborApp.composeToAgent(ref);
}

async function setRoot(r: string | null, force?: boolean) {
  if (!force && r === root) return;
  root = r;
  if (r) knownRoots.add(r);
  if (!ready) return;
  Tree().setRoot(r);
  if (r && !indexByRoot.has(r))
    H.fileIndex(r)
      .then((f: string[]) => indexByRoot.set(r, f))
      .catch(() => {});
}

export const harborEditor = {
  init,
  setRoot,
  openFile,
  openQuickOpen,
  fileIndexLoaded,
  loadFileIndex,
  fileMatches,
  fileRowHtml,
  openFileResult,
  absPath,
  colorizeLines,
  dirtyText,
  openTextDiff,
  showContextMenu,
  save: () => save(),
  closeTab,
  dropPath,
  renderTabs,
  show,
  preload,
  tabInfo,
  saveView,
  focusGroup,
  groupFocused,
  disposeGroup,
  revealInTree,
  layoutGroup: (gid: string) => {
    const ed = editors.get(gid),
      dd = diffs.get(gid);
    if (ed) ed.layout();
    if (dd) dd.ed.layout();
  },
  showDiff,
  diffInfo,
  closeDiff,
  dropDiff,
  openDiff,
  invalidateIndex: (r: string) => indexByRoot.delete(r),
  refreshDiffs,
  /** Text of the focused editor's single-line selection, '' when none (or the editor isn't focused). */
  selectedText() {
    const sel = editor?.hasTextFocus() && editor.getSelection();
    return editor && sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber
      ? (editor.getModel() as Model).getValueInRange(sel)
      : '';
  },
  /** Text of `path`'s open model (null when it isn't open). */
  modelText: (path: string) => models.get(path)?.model?.getValue() ?? null,
  /** Apply replace edits [{ l, c, n, text }] to `path`'s open model (left unsaved). */
  applyModelEdits(path: string, edits: { l: number; c: number; n: number; text: string }[]) {
    const model = models.get(path)?.model;
    if (model)
      model.pushEditOperations(
        [],
        edits.map((e) => ({ range: new monaco.Range(e.l, e.c + 1, e.l, e.c + 1 + e.n), text: e.text })),
        () => null,
      );
  },
  toggleRich,
  focus() {
    const gid = [...editors].find(([, e]) => e === editor);
    const rv = gid && richViews.get(gid[0]);
    if (rv?.path) rv.view.focus();
    else if (editor) editor.focus();
  },
  setLspStatus(list?: LspStatus[]) {
    lspStatus = list || [];
    renderStatus();
    for (const f of lspListeners) f();
  },
  dirtyCount: (r: string) => [...models.values()].filter((m) => m.root === r && isDirty(m)).length,
  forgetRoot(r: string) {
    knownRoots.delete(r);
    Tree().forgetRoot(r);
    indexByRoot.delete(r);
    Lay().forgetRoot(r);
  },
  get editor() {
    return editor;
  },
  get root() {
    return root;
  },
};

window.harborEditor = harborEditor;
