// Live PR diff editors by `<root>\0<rel path>`, so a finding's "Jump" can scroll an open diff, or leave the line for the one about to open.
import type * as Monaco from 'monaco-editor';

const live = new Map<string, Monaco.editor.IStandaloneDiffEditor>();
let pending: { key: string; line: number } | null = null;
const keyOf = (root: string, rel: string) => `${root}\0${rel}`;

function reveal(diff: Monaco.editor.IStandaloneDiffEditor, line: number) {
  const ed = diff.getModifiedEditor();
  const n = ed.getModel()?.getLineCount() ?? line;
  const lineNumber = Math.min(Math.max(1, line), n);
  ed.setPosition({ lineNumber, column: 1 });
  ed.revealLineInCenter(lineNumber);
}

/** A PR diff editor for `rel` is showing: take a pending jump, and be reachable by later ones. Returns the unregister. */
export function registerPrDiff(root: string, rel: string, diff: Monaco.editor.IStandaloneDiffEditor) {
  const k = keyOf(root, rel);
  live.set(k, diff);
  if (pending?.key === k) {
    const line = pending.line;
    pending = null;
    setTimeout(() => reveal(diff, line), 50); // after the first layout
  }
  return () => {
    if (live.get(k) === diff) live.delete(k);
  };
}

/** Scroll the diff of `rel` to `line` (RIGHT side), now if it's open, else when it opens. */
export function revealPrLine(root: string, rel: string, line: number) {
  const k = keyOf(root, rel);
  const d = live.get(k);
  if (d) reveal(d, line);
  else pending = { key: k, line };
}
