// File models and their language-server sessions: create/cache models, track dirty state,
// save/reload, diagnostics, server-pushed edits. UI side-effects (status bar, rich view sync,
// group editor view-state) are delegated through `hooks`, installed by the editor module.
import type * as Monaco from 'monaco-editor';
import { tawnyDebug } from '../components/debug/session';
import { refreshGit } from '../components/tree/store';
import { activeFile, activeKey, hasFile } from '../components/workspace/layoutStore';
import { renderTabs } from '../components/workspace/panes';
import { appSettings, toast } from '../lib/actions';
import { H } from '../lib/tawny';
import {
  base,
  type Diag,
  editsByFile,
  languageFor,
  parseDiff,
  parseMermaidKey,
  sep,
  toLspRange,
  toRange,
  uriToPath,
} from './protocol';

// Monaco is loaded at runtime by the AMD loader (vs/loader.js) and lands on the global scope.
declare const monaco: typeof Monaco;

// biome-ignore lint/suspicious/noExplicitAny: LSP payloads are loosely typed
type Any = any;
export type Model = Monaco.editor.ITextModel;
type Ed = Monaco.editor.IStandaloneCodeEditor;

export interface Meta {
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
  /** formatter/linter covering this file (probed on open); null = none, undefined = not probed yet */
  tool?: 'Biome' | 'RuboCop' | null;
  conflict: boolean;
  viewState: Monaco.editor.ICodeEditorViewState | null;
  diags: Diag[];
  bgSave?: ReturnType<typeof setTimeout>;
}

/** UI that still lives in the editor module; wired via configureModels() at boot. */
export const hooks = {
  renderStatus: () => {},
  syncRichFromModel: (_path: string, _text: string) => {},
  editorsShowing: (_model: Model) => [] as Ed[],
};
export function configureModels(h: Partial<typeof hooks>) {
  Object.assign(hooks, h);
}

let root: string | null = null; // active worktree
export const knownRoots = new Set<string>();
export const models = new Map<string, Meta>(); // path -> meta
const pendingDiags = new Map<string, Diag[]>(); // path -> lsp diagnostics queued until the model exists

export const currentRoot = () => root;
export function setCurrentRootState(r: string | null) {
  root = r;
}

export const metaOf = (model: Model | null | undefined) => (model ? models.get(model.uri.path) : undefined);
export const isDirty = (m: Meta | null | undefined) => !!m?.model && m.model.getAlternativeVersionId() !== m.savedAlt;
export const isOpenInTab = (p: string) => hasFile(p);
/** File of the focused tab: a file, a diff's working-tree side or a mermaid diagram tab's markdown file. */
const activeDocPath = () => activeFile() || parseDiff(activeKey())?.path || parseMermaidKey(activeKey())?.path || '';

export function rootFor(p: string) {
  if (root && (p === root || p.startsWith(root + sep))) return root;
  for (const r of knownRoots) if (p.startsWith(r + sep)) return r;
  return root;
}

export async function ensureModel(path: string, { lsp = false } = {}): Promise<Meta> {
  let m = models.get(path);
  let file: Any = null;
  if (!m) {
    file = await H.read(path);
    m = models.get(path); // a concurrent call (e.g. a restored tab's preload) created it while the file was read
  }
  if (!m) {
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
      tawnyDebug.modelCreated(path, model);
      model.onDidChangeContent((e) => onModelChange(created as Meta & { model: Model }, e));
      const pd = pendingDiags.get(path);
      if (pd) {
        setDiagnostics(created, pd);
        pendingDiags.delete(path);
      }
    }
  }
  if (lsp && m.model && !m.lspOpen && !m.lspPending) await openLsp(m as Meta & { model: Model });
  if (lsp && m.model && m.tool === undefined) void probeTool(m as Meta & { model: Model });
  return m;
}

/** Throwaway whole-file format request: tells whether Biome/RuboCop covers the file (edits discarded). */
async function probeTool(m: Meta & { model: Model }) {
  if (!m.root) return;
  const probed = m.root;
  const opts = m.model.getOptions();
  const r = await H.lspFormat(probed, m.path, m.model.getValue(), false, {
    tabSize: opts.tabSize,
    insertSpaces: opts.insertSpaces,
  }).catch(() => null);
  m.tool = r?.supported ? (m.kind === 'ruby' ? 'RuboCop' : 'Biome') : null;
  hooks.renderStatus();
}

export async function openLsp(m: Meta & { model: Model }) {
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
    hooks.renderStatus();
  }
}

let applyingDisk = false;
function onModelChange(m: Meta & { model: Model }, e: Monaco.editor.IModelContentChangedEvent) {
  hooks.syncRichFromModel(m.path, m.model.getValue());
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

/** Format the buffer with the project's formatter (Biome, or RuboCop via ruby-lsp) over LSP (whole file, or only the lines changed since HEAD). False when no formatter covers the file. */
export async function formatDocument(path?: string, changesOnly = false, quiet = false) {
  const m = models.get(path || activeDocPath());
  const model = m?.model;
  if (!m || !model) return false;
  const before = model.getAlternativeVersionId();
  const opts = model.getOptions();
  const r = m.root
    ? await H.lspFormat(m.root, m.path, model.getValue(), changesOnly, {
        tabSize: opts.tabSize,
        insertSpaces: opts.insertSpaces,
      })
    : null;
  if (!r?.supported) {
    if (!quiet) toast('No formatter set up for this file (Biome, or RuboCop via Ruby LSP)');
    return false;
  }
  if (r.error) {
    toast(`Format: ${r.error}`);
    return false;
  }
  if (model.getAlternativeVersionId() !== before) return false; // edited while formatting: don't clobber
  if (!r.edits.length) {
    if (!quiet) toast(changesOnly ? 'No changes to format' : 'Already formatted');
    return true;
  }
  const shown = hooks.editorsShowing(model);
  const states = shown.map((ed) => ed.saveViewState());
  model.pushStackElement();
  model.pushEditOperations(
    [],
    r.edits.map((e) => ({ range: toRange(e.range), text: e.newText })),
    () => null,
  );
  model.pushStackElement();
  for (const [i, ed] of shown.entries()) ed.restoreViewState(states[i]);
  return true;
}

export async function save(path?: string) {
  const m = models.get(path || activeDocPath());
  const model = m?.model;
  if (!m || !model) return;
  const s = appSettings();
  if (s.formatOnSave === 'document' || s.formatOnSave === 'changes')
    await formatDocument(m.path, s.formatOnSave === 'changes', true);
  const text = model.getValue();
  try {
    m.mtime = await H.write(m.path, text);
    m.savedAlt = model.getAlternativeVersionId();
    m.conflict = false;
    if (m.lspOpen) H.lspSave(m.root as string, m.kind as string, m.uri as string, text);
    tawnyDebug.saved(m.path);
    renderTabs();
    refreshGit();
  } catch (e) {
    toast(`Save failed: ${(e as Error).message}`);
  }
}

/** File changed on disk (agent edits): reload clean buffers in place, flag dirty ones. */
export async function reloadFromDisk(path: string, force = false) {
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
  if (isDirty(m) && !force) {
    m.conflict = true;
    renderTabs();
    return;
  }
  applyingDisk = true;
  try {
    const shown = hooks.editorsShowing(m.model);
    const states = shown.map((ed) => ed.saveViewState());
    m.model.pushEditOperations([], [{ range: m.model.getFullModelRange(), text: file.text }], () => null);
    m.savedAlt = m.model.getAlternativeVersionId();
    m.mtime = file.mtime;
    m.conflict = false;
    for (const [i, ed] of shown.entries()) ed.restoreViewState(states[i]);
  } finally {
    applyingDisk = false;
  }
  renderTabs();
}

/** Drop unsaved edits: reload the buffer from disk (undo still brings them back). */
export async function revert(path?: string) {
  const p = path || activeDocPath();
  const m = models.get(p);
  if (m?.model && (isDirty(m) || m.conflict)) await reloadFromDisk(p, true);
}

/** LSP request against a model's open language-server session (null when closed/errored). */
export async function req(model: Model, method: string, params: Record<string, unknown> = {}) {
  const m = metaOf(model);
  if (!m?.kind || !m.lspOpen) return null;
  try {
    return await H.lspRequest(m.root as string, m.kind, method, { textDocument: { uri: m.uri }, ...params });
  } catch {
    return null;
  }
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
  hooks.renderStatus();
}

H.onDiagnostics((_root, p) => {
  const path = uriToPath(p.uri);
  if (!path) return;
  const m = models.get(path);
  if (m) setDiagnostics(m, p.diagnostics || []);
  else pendingDiags.set(path, p.diagnostics || []);
});

H.onLspRestarted(async (r: string, kind: string) => {
  for (const m of models.values()) {
    if (m.root === r && m.kind === kind && m.model && isOpenInTab(m.path)) {
      m.lspOpen = false;
      await openLsp(m as Meta & { model: Model });
    }
  }
});

H.onFsChanged((_r: string, paths: string[]) => {
  for (const p of paths) if (models.has(p)) reloadFromDisk(p);
  if (paths.some((p) => /(^|\/)biome\.jsonc?$/.test(p)))
    for (const m of models.values()) if (m.model && m.tool !== undefined) void probeTool(m as Meta & { model: Model });
});

// ------------------------------------------------------------------ workspace edits (server-pushed)

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
