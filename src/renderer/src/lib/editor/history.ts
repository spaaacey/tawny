// Editor navigation history (go back/forward, ⌘- / ⇧⌘- in the editor). Positions come
// from the focused Monaco editor and replays open files as tabs — both are editor-layer
// concerns and arrive through `deps`, wired by legacy/editor.ts at boot (same pattern
// as lsp/models.ts's configureModels).
import type * as Monaco from 'monaco-editor';
import { metaOf } from '../../lsp/models';
import type { Pos } from '../../lsp/protocol';

type Ed = Monaco.editor.IStandaloneCodeEditor;

/** Editor-layer effects used here; wired by legacy/editor.ts at boot. */
export const deps = {
  openFile: (_path: string, _opts?: { selection?: Pos; recordHistory?: boolean }): unknown => undefined,
  currentEditor: (): Ed | null => null,
};
export function configureHistory(d: Partial<typeof deps>) {
  Object.assign(deps, d);
}

const history: { path: string; line: number; col: number }[] = []; // [{path, line, col}] for go back
let historyPos = -1;

export function pushHistory() {
  const editor = deps.currentEditor();
  if (!editor?.getModel()) return;
  const m = metaOf(editor.getModel());
  if (!m) return;
  const p = editor.getPosition() as Pos;
  history.splice(historyPos + 1);
  history.push({ path: m.path, line: p.lineNumber, col: p.column });
  if (history.length > 100) history.shift();
  historyPos = history.length - 1;
}

export function goHistory(dir: number) {
  if (dir < 0 && historyPos === history.length - 1) {
    pushHistory();
    historyPos--;
  }
  const i = historyPos + dir;
  const h = history[i];
  if (!h) return;
  historyPos = i;
  deps.openFile(h.path, { selection: { lineNumber: h.line, column: h.col }, recordHistory: false });
}
