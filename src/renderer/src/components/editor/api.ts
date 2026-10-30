// Tawny editor: Monaco + language servers (via main process), tabs, file tree, ⌘P file search.
import type * as Monaco from 'monaco-editor';
import type { LspInfo } from '../../../../shared/types';
import { openPalette, toast } from '../../lib/actions';
import { confirmDialog } from '../../lib/dialog';
import { configureFileIndex, invalidateIndex, rel, warmIndex } from '../../lib/editor/fileIndex';
import { configureHistory, pushHistory } from '../../lib/editor/history';
import { H } from '../../lib/tawny';
import { theme } from '../../lib/theme';
import {
  configureModels,
  currentRoot,
  ensureModel,
  isDirty,
  isOpenInTab,
  knownRoots,
  type Meta,
  models,
  setCurrentRootState,
} from '../../lsp/models';
import { base, languageFor, parseDiff } from '../../lsp/protocol';
import { registerProviders } from '../../lsp/providers';
import { tawnyDebug } from '../debug/session';
import { forgetRoot as forgetTreeRoot, touch as markActive, revealInTree, setRoot as setTreeRoot } from '../tree/store';
import {
  activeFile,
  filesOf,
  focusedGroup,
  forgetRoot as forgetLayoutRoot,
  hasKey,
  openKey,
  openDiff as openLayoutDiff,
  openFile as openLayoutFile,
  removeFile,
  removeKey,
} from '../workspace/layoutStore';
import { showContextMenu } from './ContextMenu';
import { renderStatus, setLspInfo } from './EditorStatus';
import {
  configureHost,
  currentEditor,
  diffs,
  editors,
  focusGroup,
  forgetRichPath,
  lspListeners,
  releaseDiffsUsing,
  richViews,
  setSettings,
  snapshots,
  textDiffs,
} from './host';

export type { FileMatch } from '../../lib/editor/fileIndex';

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

const _$ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

let ready = false;
const readyWaiters: (() => void)[] = [];

// The Monaco hosts (components/editor/host.ts) call back into this module for the status bar, toasts and menus.
// (Wrapped: this module sits in an import cycle with actions / the stores, so the imports aren't initialised yet.)
configureHost({
  whenReady,
  openFile,
  renderStatus: () => renderStatus(),
  toast: (msg) => toast(msg),
  markTreeActive: () => markActive(),
  showContextMenu: (...a) => showContextMenu(...a),
});

// The models module (lsp/models.ts) pushes UI effects back through these hooks.
configureModels({
  renderStatus: () => renderStatus(),
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
  currentEditor: () => currentEditor(),
});
configureFileIndex({
  openFile: (path, opts) => openFile(path, opts),
  openPalette: (q) => openPalette(q),
  recentFiles: (root) => filesOf(root).reverse(),
});

// ------------------------------------------------------------------ opening / tabs

export async function openFile(path: string, opts: OpenOpts = {}) {
  await whenReady();
  if (opts.recordHistory !== false) pushHistory();
  const gid = await openLayoutFile(path, { focus: opts.focus !== false, preview: !!opts.preview, pin: !!opts.pin });
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
export async function preload(paths: string[]) {
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

export async function closeTab(pathArg?: string) {
  const path = pathArg || activeFile();
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
  removeFile(path);
  // drop the model once no worktree has it open
  if (m && !isOpenInTab(path)) {
    freeModel(m, path);
  }
}

/** Free the model of a tab replaced in place, unless it is open elsewhere. */
export function dropPath(path: string) {
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

export function tabInfo(path: string) {
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

export function diffInfo(key: string) {
  const d = parseDiff(key);
  if (!d) return { name: key, title: key, dirty: false };
  if (d.mode === 'c') {
    const sh = (d.sha as string).slice(0, 7);
    return { name: `${base(d.path)} (${sh})`, title: `${rel(d.path)} — ${sh}^ ↔ ${sh}`, dirty: false };
  }
  if (d.mode === 'o') {
    const label = snapshots.get(key)?.label ?? 'original';
    return { name: `${base(d.path)} (${label})`, title: `${rel(d.path)} — ${label}`, dirty: false };
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

export async function openTextDiff(path: string, oldText: unknown, newText: unknown) {
  const key = `d:t:${++textDiffSeq}:${path}`;
  textDiffs.set(key, {
    oldText: oldText == null ? '' : String(oldText),
    newText: newText == null ? '' : String(newText),
  });
  await whenReady();
  const gid = await openKey(key, { pin: true });
  if (gid) focusGroup(gid);
}

/** Diff editor of the focused group while it shows a diff. */
function focusedDiff() {
  const gid = focusedGroup();
  const dd = gid ? diffs.get(gid) : undefined;
  return dd?.shown && dd.path ? dd : null;
}

/** From a diff: open the working-tree file in a normal editor tab, at the diff's cursor line. */
export async function openDiffFile() {
  const dd = focusedDiff();
  if (!dd?.hasFile) return;
  const pos = dd.ed.getModifiedEditor().getPosition();
  await openFile(dd.path as string, {
    selection: pos ? { lineNumber: pos.lineNumber, column: pos.column } : undefined,
  });
}

/** From a diff: open its old side (HEAD / index / parent commit) as a read-only snapshot tab, at the original side's cursor line. */
export async function openDiffOriginal() {
  const dd = focusedDiff();
  const model = dd?.ed.getModel();
  if (!dd || !model || !dd.hasOrig || dd.mode === 'o') return;
  const path = dd.path as string;
  const d = parseDiff(dd.key);
  const label =
    dd.mode === 'c'
      ? `${(d?.sha ?? '').slice(0, 7)}^`
      : dd.mode === 's'
        ? 'HEAD'
        : dd.mode === 'w'
          ? 'Index'
          : 'Before';
  const pos = dd.ed.getOriginalEditor().getPosition();
  const key = `d:o:${++textDiffSeq}:${path}`;
  snapshots.set(key, { text: model.original.getValue(), label });
  await whenReady();
  const gid = await openKey(key, { pin: true });
  if (!gid) return;
  focusGroup(gid);
  if (pos) {
    const ed = diffs.get(gid)?.ed.getModifiedEditor();
    ed?.setPosition(pos);
    ed?.revealPositionInCenterIfOutsideViewport(pos, 0);
  }
}

export async function openDiff(mode: string, path: string, opts: OpenOpts = {}) {
  await whenReady();
  const gid = await openLayoutDiff(mode, path, opts);
  if (gid) focusGroup(gid);
}

/** Free the model of a diff tab replaced in place, unless a file tab still has it. */
export function dropDiff(key: string) {
  const d = parseDiff(key);
  const m = d?.mode === 'w' ? models.get(d.path) : null;
  if (d && m && !isOpenInTab(d.path)) freeModel(m, d.path);
}

export async function closeDiff(key: string) {
  const d = parseDiff(key);
  if (!d) return;
  const m = d.mode === 'w' ? models.get(d.path) : null;
  if (
    isDirty(m) &&
    !hasKey(`f:${d.path}`) &&
    !(await confirmDialog({
      title: 'Unsaved changes',
      message: `${base(d.path)} has unsaved changes. Close anyway?`,
      confirmLabel: 'Close anyway',
      danger: true,
    }))
  )
    return;
  removeKey(key);
  textDiffs.delete(key);
  if (m && !isOpenInTab(d.path)) freeModel(m, d.path);
}

// ------------------------------------------------------------------ file tree (React: components/tree)

/** Syntax-highlighted lines (HTML) of `text` as `path`'s language, or null when too long or unavailable. */
export async function colorizeLines(text: string, path: string) {
  await whenReady();
  if (text.length > 60000) return null;
  try {
    return (await monaco.editor.colorize(text, languageFor(path), { tabSize: 2 })).split(/<br\s*\/?>/);
  } catch {
    return null;
  }
}

/** Unsaved text of an open file, or null when it isn't open or has no unsaved changes (for `fs/read_text_file`). */
export function dirtyText(path: string) {
  const m = models.get(path);
  return m?.model && isDirty(m) ? m.model.getValue() : null;
}

// ------------------------------------------------------------------ misc UI

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

export { setSettings } from './host';

export function init(state: Any) {
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
    tawnyDebug.init(ui);
    ready = true;
    for (const f of readyWaiters.splice(0)) f();
    const r = currentRoot();
    if (r) setRoot(r, true);
  });
}

export async function setRoot(r: string | null, force?: boolean) {
  if (!force && r === currentRoot()) return;
  setCurrentRootState(r);
  if (r) knownRoots.add(r);
  if (!ready) return;
  setTreeRoot(r);
  warmIndex(r);
}

/** Text of the focused editor's single-line selection, '' when none (or the editor isn't focused). */
export function selectedText() {
  const editor = currentEditor();
  const sel = editor?.hasTextFocus() && editor.getSelection();
  return editor && sel && !sel.isEmpty() && sel.startLineNumber === sel.endLineNumber
    ? (editor.getModel() as Model).getValueInRange(sel)
    : '';
}

/** Text of `path`'s open model (null when it isn't open). */
export const modelText = (path: string) => models.get(path)?.model?.getValue() ?? null;

/** Apply replace edits [{ l, c, n, text }] to `path`'s open model (left unsaved). */
export function applyModelEdits(path: string, edits: { l: number; c: number; n: number; text: string }[]) {
  const model = models.get(path)?.model;
  if (model)
    model.pushEditOperations(
      [],
      edits.map((e) => ({ range: new monaco.Range(e.l, e.c + 1, e.l, e.c + 1 + e.n), text: e.text })),
      () => null,
    );
}

export function setLspStatus(list?: LspInfo[]) {
  setLspInfo(list || []);
  for (const f of lspListeners) f();
}

export function forgetRoot(r: string) {
  knownRoots.delete(r);
  forgetTreeRoot(r);
  invalidateIndex(r);
  forgetLayoutRoot(r);
}
