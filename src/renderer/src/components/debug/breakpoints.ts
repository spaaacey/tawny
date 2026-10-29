import type * as Monaco from 'monaco-editor';
import { create } from 'zustand';
import { H } from '../../lib/tawny';

export interface Bp {
  line: number;
  condition?: string;
  logMessage?: string;
  id?: string;
}
interface Meta {
  condition?: string;
  logMessage?: string;
  verified?: boolean;
}

declare global {
  interface Window {
    monaco: typeof Monaco;
  }
}

/** The Monaco side of the debugger: breakpoint decorations, the stopped-line marker and the tiny prompt. */

// Decorations on the Monaco model are the truth while a model exists (they follow edits); `saved` holds the rest.
const saved = new Map<string, Bp[]>();
const live = new Map<string, Map<string, Meta>>();
/** adapter breakpoint id → where we drew it, so later `breakpoint` events can flip it solid/hollow */
export const bpIds = new Map<number, { path: string; id: string }>();
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let onChanged: (path: string | null) => void = () => {};
/** session.ts registers here so a breakpoint edit during a session re-syncs that file with the adapter */
export const setChangedHook = (fn: (path: string | null) => void) => {
  onChanged = fn;
};

export const modelOf = (path: string) =>
  window.monaco ? window.monaco.editor.getModel(window.monaco.Uri.file(path)) : null;

function bpOptions(meta: Meta): Monaco.editor.IModelDecorationOptions {
  const kind = meta.logMessage ? 'log' : meta.condition ? 'cond' : 'bp';
  const tip = meta.logMessage
    ? `Logpoint: ${meta.logMessage}`
    : meta.condition
      ? `Breakpoint when: ${meta.condition}`
      : 'Breakpoint';
  return {
    glyphMarginClassName: `dbg-${kind}${meta.verified === false ? ' dbg-unverified' : ''}`,
    glyphMarginHoverMessage: { value: meta.verified === false ? `${tip} (not bound)` : tip },
    stickiness: window.monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
  };
}
const bpRange = (line: number) => new window.monaco.Range(line, 1, line, 1);

export function modelCreated(path: string, model: Monaco.editor.ITextModel) {
  const list = saved.get(path);
  saved.delete(path);
  const m = new Map<string, Meta>();
  live.set(path, m);
  if (!list) return;
  const ids = model.deltaDecorations(
    [],
    list.map((b) => ({ range: bpRange(Math.min(b.line, model.getLineCount())), options: bpOptions(b) })),
  );
  for (const [i, id] of ids.entries()) m.set(id, { condition: list[i].condition, logMessage: list[i].logMessage });
}

/** Current breakpoints of a file, sorted by line, one per line. */
export function listFor(path: string): Bp[] {
  const m = live.get(path);
  const model = modelOf(path);
  if (!m || !model) return (saved.get(path) || []).map((b) => ({ ...b }));
  const byLine = new Map<number, Bp>();
  for (const [id, meta] of m) {
    const r = model.getDecorationRange(id);
    if (r)
      byLine.set(r.startLineNumber, {
        line: r.startLineNumber,
        condition: meta.condition,
        logMessage: meta.logMessage,
        id,
      });
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

const allPaths = () => new Set([...saved.keys(), ...live.keys()]);
export function allBreakpoints() {
  const out: Record<string, Omit<Bp, 'id'>[]> = {};
  for (const p of allPaths()) {
    const l = listFor(p).map(({ line, condition, logMessage }) => ({ line, condition, logMessage }));
    if (l.length) out[p] = l;
  }
  return out;
}

function setList(path: string, list: Bp[]) {
  const model = modelOf(path);
  const m = live.get(path);
  if (!model || !m) {
    if (list.length) saved.set(path, list);
    else saved.delete(path);
    return;
  }
  model.deltaDecorations([...m.keys()], []);
  m.clear();
  const ids = model.deltaDecorations(
    [],
    list.map((b) => ({ range: bpRange(b.line), options: bpOptions(b) })),
  );
  for (const [i, id] of ids.entries()) m.set(id, { condition: list[i].condition, logMessage: list[i].logMessage });
}

function changed(path: string | null) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => H.saveUi({ breakpoints: allBreakpoints() }), 300);
  onChanged(path);
}

/** Flush a closing file's breakpoints that live on its model into the fallback map */
export function syncOnSave(path: string) {
  if (live.has(path)) onChanged(path);
}

/** Adapter verdicts (one per breakpoint, in request order) → hollow markers for the ones it couldn't bind. */
export function applyResults(path: string, list: Bp[], results: { id?: number; verified?: boolean }[] | undefined) {
  const m = live.get(path);
  const model = modelOf(path);
  if (!m || !model || !results) return;
  list.forEach((b, i) => {
    const r = results[i];
    const meta = b.id ? m.get(b.id) : undefined;
    if (!r || !meta || !b.id) return;
    if (r.id !== undefined) bpIds.set(r.id, { path, id: b.id });
    const verified = r.verified !== false;
    if (meta.verified === verified || (meta.verified === undefined && verified)) return;
    meta.verified = verified;
    const range = model.getDecorationRange(b.id);
    if (range) model.deltaDecorations([b.id], [{ range: bpRange(range.startLineNumber), options: bpOptions(meta) }]);
  });
}

/** An adapter `breakpoint` event changed whether one of ours is bound */
export function setVerified(adapterId: number, verified: boolean) {
  const hit = bpIds.get(adapterId);
  const meta = hit && live.get(hit.path)?.get(hit.id);
  const model = hit && modelOf(hit.path);
  if (!hit || !meta || !model || meta.verified === verified) return;
  meta.verified = verified;
  const r = model.getDecorationRange(hit.id);
  if (r) model.deltaDecorations([hit.id], [{ range: bpRange(r.startLineNumber), options: bpOptions(meta) }]);
}

export function toggleBreakpoint(path: string | undefined | null, line: number | undefined | null) {
  if (!path || !line) return;
  const list = listFor(path);
  const at = list.findIndex((b) => b.line === line);
  if (at >= 0) list.splice(at, 1);
  else list.push({ line });
  setList(path, list);
  changed(path);
}

/** Add or edit a conditional breakpoint / logpoint on `line` (empty text turns it back into a plain breakpoint). */
export async function editBreakpoint(path: string, line: number, field: 'condition' | 'logMessage') {
  const list = listFor(path);
  const cur = list.find((b) => b.line === line) || { line };
  const text = await ask(
    field === 'logMessage' ? 'Log message (use {expr} to interpolate)…' : 'Break when expression is true…',
    cur[field] || '',
  );
  if (text === null) return;
  const next: Bp = { line, [field]: text.trim() || undefined };
  setList(
    path,
    [...list.filter((b) => b.line !== line), next].sort((a, b) => a.line - b.line),
  );
  changed(path);
}

export function removeAll(syncPaths: boolean) {
  for (const p of allPaths()) setList(p, []);
  saved.clear();
  if (syncPaths) for (const p of live.keys()) onChanged(p);
  changed(null);
}

export function restore(ui: { breakpoints?: Record<string, Bp[]> } | undefined) {
  for (const [path, list] of Object.entries(ui?.breakpoints || {})) saved.set(path, list);
}

// ---------------------------------------------------------------- tiny prompt (rendered by DebugPanel)

interface Prompt {
  placeholder: string;
  initial: string;
  done(v: string | null): void;
}
export const usePrompt = create<{ prompt: Prompt | null }>(() => ({ prompt: null }));

function ask(placeholder: string, initial: string): Promise<string | null> {
  return new Promise((resolve) => {
    const prev = document.activeElement as HTMLElement | null;
    usePrompt.setState({
      prompt: {
        placeholder,
        initial,
        done: (v) => {
          usePrompt.setState({ prompt: null });
          if (prev?.isConnected) prev.focus();
          resolve(v);
        },
      },
    });
  });
}

// ---------------------------------------------------------------- stopped line

let curLine: { model: Monaco.editor.ITextModel; ids: string[] } | null = null;
export function clearLine() {
  if (curLine && !curLine.model.isDisposed()) curLine.model.deltaDecorations(curLine.ids, []);
  curLine = null;
}
export function markLine(path: string, line: number) {
  clearLine();
  const model = modelOf(path);
  if (!model) return;
  const ids = model.deltaDecorations(
    [],
    [
      {
        range: new window.monaco.Range(line, 1, line, 1),
        options: { isWholeLine: true, className: 'dbg-line', glyphMarginClassName: 'dbg-arrow' },
      },
    ],
  );
  curLine = { model, ids };
}

/** The expression under the cursor: the dotted/:: chain up to and including the hovered identifier. */
export function expressionAt(model: Monaco.editor.ITextModel, pos: Monaco.Position) {
  const text = model.getLineContent(pos.lineNumber);
  const re = /[A-Za-z_$@][\w$]*(?:(?:\?\.|&\.|\.|::)[A-Za-z_$][\w$]*[?!]?)*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const s = m.index;
    const e = s + m[0].length;
    if (pos.column - 1 < s || pos.column - 1 > e) continue;
    const w = model.getWordAtPosition(pos);
    if (!w) return null;
    return {
      expr: text.slice(s, w.endColumn - 1),
      range: new window.monaco.Range(pos.lineNumber, s + 1, pos.lineNumber, w.endColumn),
    };
  }
  return null;
}

export function attach(ed: Monaco.editor.IStandaloneCodeEditor) {
  // The glyph column is 18px of dead space, so it only exists while the file has a breakpoint or the stopped arrow;
  // until then a click on the line number toggles the first breakpoint.
  const syncMargin = () => {
    const model = ed.getModel();
    const want = !!model && (!!live.get(model.uri.path)?.size || curLine?.model === model);
    if (want !== ed.getOption(window.monaco.editor.EditorOption.glyphMargin)) ed.updateOptions({ glyphMargin: want });
  };
  ed.onDidChangeModel(syncMargin);
  // deferred: `live` is updated right after the decoration change that fires this
  ed.onDidChangeModelDecorations(() => queueMicrotask(syncMargin));
  ed.onMouseDown((e) => {
    const T = window.monaco.editor.MouseTargetType;
    if (
      (e.target.type !== T.GUTTER_GLYPH_MARGIN && e.target.type !== T.GUTTER_LINE_NUMBERS) ||
      !e.event.leftButton ||
      !ed.getModel() ||
      !e.target.position
    )
      return;
    toggleBreakpoint(ed.getModel()?.uri.path, e.target.position.lineNumber);
  });
  const at = () => ({ path: ed.getModel()?.uri.path, line: ed.getPosition()?.lineNumber });
  const action = (id: string, label: string, order: number, run: (path: string, line: number) => void) =>
    ed.addAction({
      id,
      label,
      contextMenuGroupId: '8_debug',
      contextMenuOrder: order,
      run: () => {
        const { path, line } = at();
        if (path && line) run(path, line);
      },
    });
  action('tawny.debug.toggle', 'Toggle Breakpoint', 1, toggleBreakpoint);
  action('tawny.debug.cond', 'Add Conditional Breakpoint…', 2, (p, l) => editBreakpoint(p, l, 'condition'));
  action('tawny.debug.log', 'Add Logpoint…', 3, (p, l) => editBreakpoint(p, l, 'logMessage'));
}
