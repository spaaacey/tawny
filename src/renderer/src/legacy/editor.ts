// Tawny editor: Monaco + language servers (via main process), tabs, file tree, ⌘P file search.
import type * as Monaco from 'monaco-editor';
import type { LspInfo } from '../../../shared/types';
import {
  configureHost,
  currentEditor,
  diffs,
  disposeGroup,
  editors,
  focusGroup,
  forgetRichPath,
  groupFocused,
  lspListeners,
  refreshDiffs,
  releaseDiffsUsing,
  richViews,
  saveView,
  setSettings,
  show,
  showDiff,
  textDiffs,
  toggleRich,
} from '../components/editor/host';
import { alertDialog, confirmDialog } from '../lib/dialog';
import {
  absPath,
  configureFileIndex,
  fileIndexLoaded,
  fileMatches,
  fileRowHtml,
  invalidateIndex,
  loadFileIndex,
  openFileResult,
  openQuickOpen,
  rel,
  warmIndex,
} from '../lib/editor/fileIndex';
import { configureHistory, pushHistory } from '../lib/editor/history';
import { H } from '../lib/legacy';
import { theme } from '../lib/theme';
import {
  configureModels,
  currentRoot,
  ensureModel,
  isDirty,
  isOpenInTab,
  knownRoots,
  type Meta,
  metaOf,
  models,
  save,
  setCurrentRootState,
} from '../lsp/models';
import { base, languageFor, parseDiff } from '../lsp/protocol';
import { registerProviders } from '../lsp/providers';

export type { FileMatch } from '../lib/editor/fileIndex';

// Monaco is loaded at runtime by the AMD loader (vs/loader.js) and lands on the global scope.
declare const monaco: typeof Monaco;

// biome-ignore lint/suspicious/noExplicitAny: LSP payloads and the Tiptap view are loosely typed
type Any = any;
type Model = Monaco.editor.ITextModel;
type Selection = { startLineNumber?: number; lineNumber: number; column: number };

interface OpenOpts {
  focus?: boolean;
  preview?: boolean;
  pin?: boolean;
  recordHistory?: boolean;
  selection?: Selection | Monaco.IRange;
}
type LspStatus = LspInfo;
type MenuItem = { label: string; run?(): void; sub?: MenuItem[]; color?: string };

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const Lay = () => window.harborLayout;
let lspStatus: LspStatus[] = [];
let ready = false;
const readyWaiters: (() => void)[] = [];

// The Monaco hosts (components/editor/host.ts) call back into this module for the status bar, toasts and menus.
configureHost({ whenReady, openFile, renderStatus, toast, markTreeActive: () => Tree().markActive(), showContextMenu });

// The models module (lsp/models.ts) pushes UI effects back through these hooks.
configureModels({
  renderStatus,
  syncRichFromModel(path, text) {
    for (const rv of richViews.values()) {
      if (rv.path === path && !rv.syncing) {
        rv.text = text;
        rv.view.setMarkdown(text);
      }
    }
  },
  editorsShowing: (model) => [...editors.values()].filter((ed) => ed.getModel() === model),
});

// Nav history and the ⌘P file index (lib/editor) pull their editor-layer effects through these hooks.
configureHistory({
  openFile: (path, opts) => openFile(path, opts),
  currentEditor,
});
configureFileIndex({
  openFile: (path, opts) => openFile(path, opts),
  openPalette: (q) => window.harborApp.openPalette(q),
  recentFiles: (root) => Lay().filesOf(root).reverse(),
});

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
  forgetRichPath(path);
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

// ------------------------------------------------------------------ diff tabs
// 'd:s:<path>' = staged (HEAD ↔ index, read-only), 'd:w:<path>' = unstaged (index ↔ working tree, editable),
// 'd:c:<sha>:<path>' = a commit (parent ↔ commit, read-only), 'd:t:<n>:<path>' = texts held in memory (an agent's edit, read-only).

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

/** Diff of two texts that aren't in git (an agent's edit from a chat tab). */
let textDiffSeq = 0;

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

// ------------------------------------------------------------------ file tree (React: components/tree)

const Tree = () => window.harborTree;
const revealInTree = (path: string) => Tree().revealInTree(path);
const _markTreeActive = () => Tree().markActive();

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

// ------------------------------------------------------------------ status bar

function renderStatus() {
  const el = $('#edStatus');
  if (!el) return;
  el.hidden = !Lay().activeFile();
  if (el.hidden) return;
  const editor = currentEditor();
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
  const editor = currentEditor();
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

function init(state: Any) {
  setSettings(state.settings || {});
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
    registerProviders({ openFile, pushHistory });
    window.harborDebug.init(ui);
    ready = true;
    for (const f of readyWaiters.splice(0)) f();
    const r = currentRoot();
    if (r) setRoot(r, true);
  });
}

async function setRoot(r: string | null, force?: boolean) {
  if (!force && r === currentRoot()) return;
  setCurrentRootState(r);
  if (r) knownRoots.add(r);
  if (!ready) return;
  Tree().setRoot(r);
  warmIndex(r);
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
  invalidateIndex,
  refreshDiffs,
  /** Text of the focused editor's single-line selection, '' when none (or the editor isn't focused). */
  selectedText() {
    const editor = currentEditor();
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
    const editor = currentEditor();
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
    invalidateIndex(r);
    Lay().forgetRoot(r);
  },
  get editor() {
    return currentEditor();
  },
  get root() {
    return currentRoot();
  },
};

window.harborEditor = harborEditor;
