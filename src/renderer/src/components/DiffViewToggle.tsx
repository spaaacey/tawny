import { useReducer } from 'react';
import { diffs, toggleInlineDiff } from './editor/host';
import { focusedGroup } from './workspace/layoutStore';
import { useGroupView, useUiTick } from './workspace/panes';

/** Titlebar button: show the focused group's diff side by side or in a single (inline) editor. */
export function DiffViewToggle() {
  const views = useGroupView((s) => s.views);
  useUiTick((s) => s.tick);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const gid = focusedGroup();
  const dd = gid ? diffs.get(gid) : undefined;
  if (!gid || !dd || !views[gid]?.diff) return null;
  return (
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
  );
}
