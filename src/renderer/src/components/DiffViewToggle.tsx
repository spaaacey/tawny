import { useEffect, useReducer } from 'react';
import { openDiffFile, openDiffOriginal } from './editor/api';
import { diffListeners, diffs, toggleInlineDiff } from './editor/host';
import { focusedGroup } from './workspace/layoutStore';
import { useGroupView, useUiTick } from './workspace/panes';

/** Titlebar buttons for the focused group's diff: open its file / old side in a normal editor, or flip side by side <-> inline. */
export function DiffViewToggle() {
  const views = useGroupView((s) => s.views);
  useUiTick((s) => s.tick);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    diffListeners.add(bump);
    return () => void diffListeners.delete(bump);
  }, []);
  const gid = focusedGroup();
  const dd = gid ? diffs.get(gid) : undefined;
  if (!gid || !dd || !views[gid]?.diff) return null;
  const snapshot = dd.mode === 'o'; // a read-only copy of an old side: nothing to compare or flip
  return (
    <>
      {!snapshot && (
        <button
          type="button"
          className="diff-toggle"
          disabled={!dd.hasOrig}
          title="Open the old side in a read-only editor tab"
          onClick={() => openDiffOriginal()}
        >
          Open original
        </button>
      )}
      <button
        type="button"
        className="diff-toggle"
        disabled={!dd.hasFile}
        title="Open the file in the editor (cmd+option+d)"
        onClick={() => openDiffFile()}
      >
        Open file
      </button>
      {!snapshot && (
        <button
          type="button"
          className={`diff-toggle${dd.inline ? ' on' : ''}`}
          title={dd.inline ? 'Show diff side by side' : 'Show diff in a single editor (inline)'}
          onClick={() => {
            toggleInlineDiff(dd);
            bump();
          }}
        >
          {dd.inline ? 'Inline' : 'Side by side'}
        </button>
      )}
    </>
  );
}
