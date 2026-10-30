// Monaco hosting for tab groups: one code editor / diff editor per group id, created on first use and kept for the
// group's lifetime (React remounts of the pane don't touch them; gc -> disposeGroup does). The React side is
// EditorPane / DiffPane / Crumbs / RichToggle / CodeAsk, which render into the persistent host elements.
import type * as Monaco from 'monaco-editor';
import { create } from 'zustand';
import { askAgent, openPalette, sendTargets } from '../../lib/actions';
import { rel } from '../../lib/editor/fileIndex';
import { goHistory } from '../../lib/editor/history';
import { H } from '../../lib/tawny';
import { theme } from '../../lib/theme';
import { ensureModel, type Meta, metaOf, models, rootFor } from '../../lsp/models';
import { base, dirname, languageFor, parseDiff, sep } from '../../lsp/protocol';
import { tawnyDebug } from '../debug/session';
import { tawnyTree, toggleTree } from '../tree/store';
import { activeFile, focusedGroup, moveActive } from '../workspace/layoutStore';
import { markFocused } from '../workspace/panes';

declare const monaco: typeof Monaco;

// biome-ignore lint/suspicious/noExplicitAny: LSP payloads and the Tiptap view are loosely typed
type Any = any;
export type Ed = Monaco.editor.IStandaloneCodeEditor;
type DiffEd = Monaco.editor.IStandaloneDiffEditor;
type Model = Monaco.editor.ITextModel;
interface DiffState {
  ed: DiffEd;
  inline: boolean;
  shown: boolean;
  key: string | null;
  mode: string | null;
  path: string | null;
  root: string | null;
  owned: Model[];
  hasFile: boolean; // the working-tree file exists, so it can be opened
  hasOrig: boolean; // the old side exists (false for added files)
}
interface RichState {
  view: Any;
  path: string | null;
  text: string | null;
  syncing: boolean;
}
interface Settings {
  editorFontSize?: number;
  editorFontFamily?: string;
  smoothScrolling?: boolean;
  stickyScrollMaxLines?: number;
  highlightActiveBlock?: boolean;
  richMarkdown?: boolean;
}

/** Editor-layer effects that live in legacy/editor.ts (status bar, toasts, context menu, opening files). */
interface HostFx {
  whenReady(): Promise<void>;
  openFile(path: string, opts?: { preview?: boolean }): Promise<void>;
  renderStatus(): void;
  toast(msg: string): void;
  markTreeActive(): void;
  showContextMenu(x: number, y: number, items: { label: string; run?(): void }[]): void;
}
let fx = null as unknown as HostFx;
export const configureHost = (f: HostFx) => {
  fx = f;
};

export const openFile: HostFx['openFile'] = (path, opts) => fx.openFile(path, opts);

export const editors = new Map<string, Ed>(); // group id -> monaco editor (one per tab group)
export const diffs = new Map<string, DiffState>(); // group id -> { ed (diff editor), shown, key, mode, path, root, owned: [in-memory models] }
const hosts = new Map<string, HTMLElement>(); // group id -> the editor's container (rich views are created into it)
export const richViews = new Map<string, RichState>(); // group id -> { view (Tiptap, window.tawnyRich), path, text, syncing } while created
const richOverride = new Map<string, boolean>(); // markdown path -> true/false once toggled; otherwise settings.richMarkdown decides (default: rich)
const showTok = new Map<string, number>();
let editor: Ed | null = null; // the editor of the focused group
let settings: Settings = {};
export const lspListeners = new Set<() => void>(); // breadcrumb bars re-ask for symbols when a language server changes state

export const currentEditor = () => editor;
export const setCurrentEditor = (ed: Ed | null) => {
  editor = ed;
};
export const setSettings = (s: Settings) => {
  settings = s;
};

/** Which groups have a code editor yet (EditorPane renders crumbs / toggle / ask once it does). */
export const useEditorReady = create<{ ready: Record<string, true | undefined> }>(() => ({ ready: {} }));
const markReady = (gid: string, on: boolean) =>
  useEditorReady.setState((s) => {
    const ready = { ...s.ready };
    if (on) ready[gid] = true;
    else delete ready[gid];
    return { ready };
  });

/** Source / Rich switch state per group (hidden unless the shown file is markdown). */
export const useRichUi = create<{ byGid: Record<string, { able: boolean; on: boolean } | undefined> }>(() => ({
  byGid: {},
}));
const setRichUi = (gid: string, able: boolean, on: boolean) =>
  useRichUi.setState((s) => {
    const cur = s.byGid[gid];
    if (cur && cur.able === able && cur.on === on) return s;
    return { byGid: { ...s.byGid, [gid]: { able, on } } };
  });

/** Put `path` into the editor of group `gid` (creating the editor in `host` on first use). */
export async function show(
  gid: string,
  host: HTMLElement,
  path: string,
): Promise<(Meta & { error?: undefined }) | { error: true; model?: undefined; binary?: undefined }> {
  await fx.whenReady();
  const tok = (showTok.get(gid) || 0) + 1;
  showTok.set(gid, tok);
  const dd = diffs.get(gid);
  if (dd?.shown) releaseDiff(dd);
  const ed = editors.get(gid) || createEditor(gid, host);
  if (focusedGroup() === gid) editor = ed;
  const prev = ed.getModel() && metaOf(ed.getModel());
  if (prev) prev.viewState = ed.saveViewState();
  let m: Meta;
  try {
    m = await ensureModel(path, { lsp: true });
  } catch (e) {
    fx.toast(`Can't open ${base(path)}: ${(e as Error).message}`);
    return { error: true };
  }
  if (showTok.get(gid) !== tok) return m;
  if (m.model) {
    ed.setModel(m.model);
    if (m.viewState) ed.restoreViewState(m.viewState);
  } else ed.setModel(null);
  syncRich(gid, path);
  fx.renderStatus();
  fx.markTreeActive();
  return m;
}

// ------------------------------------------------------------------ rich markdown
// A Tiptap view laid over the Monaco editor of the group. The Monaco model stays the source of truth (save, dirty,
// disk reload and diffs all keep working): rich edits are written into it as markdown, model edits are pushed back.

const isRichable = (p: string) => /\.(md|markdown)$/i.test(p);
const wantsRich = (p: string) => (richOverride.has(p) ? !!richOverride.get(p) : settings.richMarkdown !== false);

function syncRich(gid: string, path: string | null) {
  const host = hosts.get(gid);
  if (!host) return;
  const m = path ? models.get(path) : undefined;
  const able = !!(m?.model && path && isRichable(path));
  const on = able && !!path && wantsRich(path);
  setRichUi(gid, able, on);
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
    state.view = (window as Any).tawnyRich.create(host, {
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
        if (target !== state.path) fx.openFile(target);
      },
      onSelectionMenu: (x: number, y: number) =>
        fx.showContextMenu(x, y, [
          { label: 'Send Selection to Agent', run: () => sendSelectionToAgent() },
          { label: 'Copy', run: () => document.execCommand('copy') },
        ]),
      ask: {
        targets: () => sendTargets(),
        send: (msg: string, id?: string) => {
          const ref = selectionRef();
          if (ref) askAgent(ref, msg, id);
        },
      },
      keys: {
        'Mod-b': () => toggleTree(),
        'Mod-Alt-l': () => sendSelectionToAgent(),
        'Mod-Alt-Shift-ArrowLeft': () => moveActive(-1),
        'Mod-Alt-Shift-ArrowRight': () => moveActive(1),
        'Mod-Alt-Shift-ArrowUp': () => moveActive('up'),
        'Mod-Alt-Shift-ArrowDown': () => moveActive('down'),
      },
    });
    state.view.el.addEventListener('focusin', () => {
      editor = editors.get(gid) || editor;
      markFocused(gid);
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

/** Forget the rich override of a freed file and hide the rich views showing it. */
export function forgetRichPath(path: string) {
  richOverride.delete(path);
  for (const rv of richViews.values())
    if (rv.path === path) {
      rv.view.el.hidden = true;
      rv.path = null;
    }
}

/** Source / Rich switch of group `gid` (and every other group showing the same file). */
export function setRichFor(gid: string, on: boolean) {
  const mm = metaOf(editors.get(gid)?.getModel() ?? null);
  if (mm) setRich(mm.path, on);
}

function setRich(path: string, on: boolean) {
  richOverride.set(path, on);
  for (const [gid, ed] of editors) {
    const mm = metaOf(ed.getModel());
    if (mm && mm.path === path) syncRich(gid, path);
  }
  const gid = focusedGroup();
  if (gid) focusGroup(gid);
}

export function toggleRich() {
  const p = activeFile();
  if (!p || !isRichable(p)) {
    fx.toast('Rich view is for markdown files');
    return;
  }
  setRich(p, !wantsRich(p));
}

export function saveView(gid: string, path: string) {
  const ed = editors.get(gid);
  const m = models.get(path);
  if (ed && m?.model && ed.getModel() === m.model) m.viewState = ed.saveViewState();
}

export function focusGroup(gid: string) {
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

export function groupFocused(gid: string) {
  const dd = diffs.get(gid);
  const ed = dd?.shown ? dd.ed.getModifiedEditor() : editors.get(gid);
  if (ed) editor = ed;
  fx.renderStatus();
  fx.markTreeActive();
}

export function disposeGroup(gid: string) {
  const dd = diffs.get(gid);
  if (dd) {
    const mod = dd.ed.getModifiedEditor();
    releaseDiff(dd);
    if (editor === mod) editor = null;
    dd.ed.dispose();
    diffs.delete(gid);
    markReady(`d:${gid}`, false);
  }
  const rv = richViews.get(gid);
  if (rv) {
    rv.view.destroy();
    richViews.delete(gid);
  }
  hosts.delete(gid);
  askZones.delete(gid);
  hideAsk(gid);
  markReady(gid, false);
  useRichUi.setState((s) => {
    const byGid = { ...s.byGid };
    delete byGid[gid];
    return { byGid };
  });
  const ed = editors.get(gid);
  if (!ed) return;
  const m = metaOf(ed.getModel());
  if (m) m.viewState = ed.saveViewState();
  editors.delete(gid);
  showTok.delete(gid);
  if (editor === ed) editor = null;
  ed.dispose();
}

/** Old-side text of a diff opened as its own read-only tab ('d:o:<n>:<path>'); gone after a restart, which closes the tab. */
export const snapshots = new Map<string, { text: string; label: string }>();
export const diffListeners = new Set<() => void>(); // told when a diff editor finishes showing a key
const notifyDiff = () => {
  for (const f of diffListeners) f();
};
export const textDiffs = new Map<string, { oldText: string; newText: string }>(); // key -> { oldText, newText }; gone after a restart, which closes the tab
const _textDiffSeq = 0;

const relIn = (r: string, p: string) => (p.startsWith(r + sep) ? p.slice(r.length + 1) : p);
let gitUriSeq = 0;
// never a file: URI, so metaOf() finds no language-server state for these models
const gitUri = (ref: string, path: string) =>
  monaco.Uri.from({ scheme: 'tawny-git', path: `/${ref}${path}`, query: String(++gitUriSeq) });
/** Original/modified text from git for a diff tab ({ orig, mod } — mod only for staged and commit diffs). */
async function diffSides(r: string, mode: string, path: string, sha?: string): Promise<{ orig: Any; mod: Any }> {
  const rl = relIn(r, path);
  if (mode === 'c') {
    const ch = tawnyTree.commitFiles(sha as string).find((x) => x.path === rl);
    const [orig, mod] = await Promise.all([H.gitShow(r, ch?.orig || rl, `${sha}^`), H.gitShow(r, rl, sha as string)]);
    return { orig, mod };
  }
  const c = tawnyTree.changes(r);
  const ch = c && (mode === 's' ? c.staged : c.unstaged).find((x) => x.path === rl);
  const orig = await H.gitShow(r, ch?.orig || rl, mode === 's' ? 'HEAD' : 'index');
  const mod = mode === 's' ? await H.gitShow(r, rl, 'index') : null;
  return { orig, mod };
}

function createDiff(gid: string, host: HTMLElement) {
  const size = settings.editorFontSize || 13;
  const mon = document.createElement('div');
  mon.className = 'ed-mon';
  host.append(mon);
  const ed = monaco.editor.createDiffEditor(mon, {
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
    renderOverviewRuler: false,
    lineNumbersMinChars: 3,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: settings.smoothScrolling !== false,
    padding: { top: 8 },
    fixedOverflowWidgets: true,
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  });
  const dd: DiffState = {
    ed,
    inline: false,
    shown: false,
    key: null,
    mode: null,
    path: null,
    root: null,
    owned: [],
    hasFile: false,
    hasOrig: true,
  };
  diffs.set(gid, dd);
  markReady(`d:${gid}`, true);
  const mod = ed.getModifiedEditor();
  for (const side of [mod, ed.getOriginalEditor()]) {
    side.onDidFocusEditorWidget(() => {
      editor = mod;
      markFocused(gid);
    });
    side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => toggleTree());
    side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => openPalette());
    addMoveTabKeys(side);
    side.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => sendSelectionToAgent());
    side.addCommand(monaco.KeyCode.F7, () => ed.goToDiff('next'));
    side.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => ed.goToDiff('previous'));
  }
  // the diff's own overview ruler is a wide strip; mark changes in the slim scrollbar ruler instead
  const marks = mod.createDecorationsCollection();
  ed.onDidUpdateDiff(() => {
    const lines = mod.getModel()?.getLineCount() ?? 1;
    const lane = monaco.editor.OverviewRulerLane;
    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const c of ed.getLineChanges() ?? []) {
      const del = c.modifiedEndLineNumber === 0;
      const add = c.originalEndLineNumber === 0;
      const start = Math.min(Math.max(1, c.modifiedStartLineNumber), lines);
      const end = del ? start : Math.min(c.modifiedEndLineNumber, lines);
      const range = new monaco.Range(start, 1, end, 1);
      // a replace shows red on the left half and green on the right
      if (!add)
        decos.push({
          range,
          options: {
            overviewRuler: {
              color: { id: 'diffEditorOverview.removedForeground' },
              position: del ? lane.Full : lane.Left,
            },
          },
        });
      if (!del)
        decos.push({
          range,
          options: {
            overviewRuler: {
              color: { id: 'diffEditorOverview.insertedForeground' },
              position: add ? lane.Full : lane.Right,
            },
          },
        });
    }
    marks.set(decos);
  });
  wireAsk(gid, mod);
  mod.addAction({
    id: 'tawny.sendToAgent',
    label: 'Send Selection to Agent',
    contextMenuGroupId: '9_tawny',
    contextMenuOrder: 1,
    run: () => sendSelectionToAgent(),
  });
  // the diff goes inline on its own in narrow panes; this pins either layout
  mod.addAction({
    id: 'tawny.toggleInlineDiff',
    label: 'Toggle Inline View',
    contextMenuGroupId: '9_tawny',
    contextMenuOrder: 2,
    run: () => toggleInlineDiff(dd),
  });
  return dd;
}

export function toggleInlineDiff(dd: DiffState) {
  dd.inline = !dd.inline;
  dd.ed.updateOptions({ renderSideBySide: !dd.inline, useInlineViewWhenSpaceIsLimited: false });
}

/** Detach the models from a diff editor and free the ones we created for it. */
export function releaseDiff(dd: DiffState) {
  dd.shown = false;
  dd.key = null;
  dd.ed.setModel(null);
  for (const m of dd.owned.splice(0)) m.dispose();
}
export function releaseDiffsUsing(model: Model) {
  for (const dd of diffs.values()) {
    const cur = dd.ed.getModel();
    if (cur && (cur.modified === model || cur.original === model)) releaseDiff(dd);
  }
}
export async function showDiff(
  gid: string,
  host: HTMLElement,
  key: string,
): Promise<{ error?: true; model?: true; binary?: true }> {
  await fx.whenReady();
  const tok = (showTok.get(gid) || 0) + 1;
  showTok.set(gid, tok);
  const d = parseDiff(key);
  if (!d) return { error: true };
  const r = rootFor(d.path);
  const dd = diffs.get(gid) || createDiff(gid, host);
  // a snapshot tab is a diff of identical texts, forced inline so it reads as a plain read-only editor
  dd.ed.updateOptions({ renderSideBySide: d.mode === 'o' ? false : !dd.inline });
  H.resolveFile('', d.path).then((p: string | null) => {
    if (showTok.get(gid) !== tok) return;
    dd.hasFile = !!p;
    notifyDiff();
  });
  if (d.mode === 'o') {
    const s = snapshots.get(key);
    if (!s) return { error: true };
    const lang = languageFor(d.path);
    const original = monaco.editor.createModel(s.text, lang, gitUri(s.label, d.path));
    const modified = monaco.editor.createModel(s.text, lang, gitUri(s.label, d.path));
    const old = dd.owned.splice(0);
    dd.ed.setModel({ original, modified });
    for (const m of old) m.dispose();
    Object.assign(dd, {
      owned: [original, modified],
      shown: true,
      key,
      mode: 'o',
      path: d.path,
      root: r,
      hasOrig: true,
    });
    dd.ed.getModifiedEditor().updateOptions({ readOnly: true });
    if (focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
    fx.renderStatus();
    notifyDiff();
    return { model: true };
  }
  if (d.mode === 't') {
    const t = textDiffs.get(key);
    if (!t) return { error: true };
    const lang = languageFor(d.path);
    const original = monaco.editor.createModel(t.oldText, lang, gitUri('before', d.path));
    const modified = monaco.editor.createModel(t.newText, lang, gitUri('after', d.path));
    const old = dd.owned.splice(0);
    dd.ed.setModel({ original, modified });
    for (const m of old) m.dispose();
    Object.assign(dd, {
      owned: [original, modified],
      shown: true,
      key,
      mode: 't',
      path: d.path,
      root: r,
      hasOrig: t.oldText !== '',
    });
    dd.ed.getModifiedEditor().updateOptions({ readOnly: true });
    if (focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
    fx.renderStatus();
    notifyDiff();
    return { model: true };
  }
  let sides: { orig: Any; mod: Any };
  let meta: Meta | null = null;
  try {
    sides = await diffSides(r as string, d.mode, d.path, d.sha);
    if (d.mode === 'w') {
      try {
        meta = await ensureModel(d.path, { lsp: true });
      } catch {
        meta = null;
      }
    } // deleted files have no model
  } catch (e) {
    fx.toast(`Can't diff ${base(d.path)}: ${(e as Error).message}`);
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
  Object.assign(dd, { owned, shown: true, key, mode: d.mode, path: d.path, root: r, hasOrig: !sides.orig.missing });
  dd.ed.getModifiedEditor().updateOptions({ readOnly: d.mode !== 'w' || !meta });
  if (focusedGroup() === gid) editor = dd.ed.getModifiedEditor();
  fx.renderStatus();
  notifyDiff();
  return { model: true };
}

/** Re-read the git side(s) of every visible diff after the index / HEAD moved. */
export async function refreshDiffs(r: string) {
  for (const dd of [...diffs.values()]) {
    if (!dd.shown || dd.root !== r || dd.mode === 'c' || dd.mode === 't' || dd.mode === 'o') continue; // commits never change
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
    ed.addCommand(m | code, () => moveActive(dir));
  }
}
/** "@file#L3-5" for the focused editor's selection (the whole file when nothing is selected); null without a file. */
export function selectionRef() {
  if (!editor) return null;
  const model = editor.getModel() as Model;
  const path = askPath(editor, model);
  if (!path) return null;
  let a: number | undefined;
  let b: number | undefined;
  const gid = gidOf(editor);
  const rv = gid && richViews.get(gid);
  if (rv && rv.path === path && !rv.view.el.hidden) {
    // rich view on top: its selection is mapped back onto the markdown source
    const r = rv.view.selectionLines(model.getValue());
    if (r) [a, b] = r;
  } else {
    const s = editor.getSelection();
    if (s) [a, b] = selectedLines(s);
  }
  let ref = `@${rel(path)}`;
  if (a) ref += a === b ? `#L${a}` : `#L${a}-${b}`;
  return ref;
}

export function sendSelectionToAgent() {
  if (!editor) return;
  const m = metaOf(editor.getModel());
  const gid = gidOf(editor);
  const rv = gid && richViews.get(gid);
  if (m && rv && rv.path === m.path && !rv.view.el.hidden && rv.view.focusAsk()) return; // rich view: type into the box over the selection
  openAsk(editor); // code / diff editor: type into the box beside the selection
}

/** The group a code editor, or the modified side of a diff editor, belongs to. */
const gidOf = (ed: Ed) =>
  [...editors].find(([, e]) => e === ed)?.[0] ?? [...diffs].find(([, d]) => d.ed.getModifiedEditor() === ed)?.[0];
/** File the editor shows: a diff's modified side stands for its file even when the model is a git snapshot. */
const askPath = (ed: Ed, model: Model) =>
  [...diffs.values()].find((d) => d.shown && d.ed.getModifiedEditor() === ed)?.path ?? metaOf(model)?.path;
/** First and last line of a selection; an empty one is its cursor line. */
const selectedLines = (s: Monaco.Selection): [number, number] => [
  s.startLineNumber,
  s.isEmpty()
    ? s.startLineNumber
    : s.endColumn === 1 && s.endLineNumber > s.startLineNumber
      ? s.endLineNumber - 1
      : s.endLineNumber,
];

// ------------------------------------------------------------------ selection message box (CodeAsk)

/** Pseudo target: start a new agent in the pane right of the editor. */
export const NEW_AGENT = '+new';
export interface AskTarget {
  id: string;
  label: string;
  working: boolean;
  waiting: boolean;
}
interface AskState {
  agents: AskTarget[];
  idx: number;
  last: number; // line the view zone sits under
  ed: Ed; // the editor the zone lives in (a diff's modified side or the code editor)
  focusTick: number;
}
export const useAsk = create<{ byGid: Record<string, AskState | undefined> }>(() => ({ byGid: {} }));
const askZones = new Map<string, HTMLElement>(); // group id -> the view zone's DOM node (CodeAsk portals into it)
export const askZone = (gid: string) => {
  let z = askZones.get(gid);
  if (!z) {
    z = document.createElement('div');
    z.className = 'ask-zone';
    askZones.set(gid, z);
  }
  return z;
};
/** Back to editing in `ed`: drop the group's box. */
function wireAsk(gid: string, ed: Ed) {
  ed.onDidChangeCursorSelection(() => {
    if (!askZone(gid).contains(document.activeElement)) hideAsk(gid);
  });
  ed.onDidChangeModel(() => hideAsk(gid));
}
const setAsk = (gid: string, st: AskState | undefined) =>
  useAsk.setState((s) => {
    const byGid = { ...s.byGid };
    if (st) byGid[gid] = st;
    else delete byGid[gid];
    return { byGid };
  });
export const hideAsk = (gid: string) => {
  if (useAsk.getState().byGid[gid]) setAsk(gid, undefined);
};

/** Open (or refocus) the message box under the selection (or cursor line). */
function openAsk(ed: Ed) {
  const gid = gidOf(ed);
  const s = ed.getSelection();
  if (!gid || !s) return;
  const cur = useAsk.getState().byGid[gid];
  if (cur?.ed === ed) setAsk(gid, { ...cur, focusTick: cur.focusTick + 1 });
  else {
    const t = sendTargets();
    const agents = [...t.agents, { id: NEW_AGENT, label: 'New agent (split right)', working: false, waiting: false }];
    const index = t.agents.length ? t.index : 0;
    setAsk(gid, { agents, idx: index, last: selectedLines(s)[1], ed, focusTick: 0 });
  }
}
export const cycleAsk = (gid: string) => {
  const cur = useAsk.getState().byGid[gid];
  if (cur && cur.agents.length > 1) setAsk(gid, { ...cur, idx: (cur.idx + 1) % cur.agents.length });
};

// ------------------------------------------------------------------ code editor

export function createEditor(gid: string, host: HTMLElement) {
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
    glyphMargin: false,
    lineDecorationsWidth: 6,
    lineNumbersMinChars: 1,
    scrollBeyondLastLine: false,
    smoothScrolling: settings.smoothScrolling !== false,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: settings.smoothScrolling !== false ? 'on' : 'off',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: settings.highlightActiveBlock ? 'active' : false, indentation: true },
    padding: { top: 8 },
    fixedOverflowWidgets: true,
    renderWhitespace: 'selection',
    stickyScroll: { enabled: true, maxLineCount: Math.max(1, settings.stickyScrollMaxLines ?? 1) },
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
  tawnyDebug.attach(ed);
  hosts.set(gid, host);
  markReady(gid, true);
  if (!editor) editor = ed;
  ed.onDidChangeCursorPosition(() => {
    if (ed === editor) fx.renderStatus();
  });
  ed.onDidFocusEditorWidget(() => {
    editor = ed;
    markFocused(gid);
  });
  // back / forward (VS Code bindings)
  ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyCode.Minus, () => goHistory(-1));
  ed.addCommand(monaco.KeyMod.WinCtrl | monaco.KeyMod.Shift | monaco.KeyCode.Minus, () => goHistory(1));
  // Chromium's rich-text ToggleBold swallows ⌘B in the editor before the menu accelerator fires
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => toggleTree());
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => openPalette()); // replaces Monaco's own palette
  addMoveTabKeys(ed);
  wireAsk(gid, ed);
  ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL, () => sendSelectionToAgent());
  ed.addAction({
    id: 'tawny.sendToAgent',
    label: 'Send Selection to Agent',
    contextMenuGroupId: '9_tawny',
    contextMenuOrder: 1,
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL],
    run: () => sendSelectionToAgent(),
  });
  return ed;
}
