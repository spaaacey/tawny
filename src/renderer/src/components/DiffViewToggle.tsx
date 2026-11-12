import { useEffect, useReducer } from 'react';
import { Button } from '@/ui/button';
import { openDiffFile, openDiffOriginal } from './editor/api';
import { diffListeners, diffs, toggleInlineDiff, useRichUi } from './editor/host';
import { useHideComments } from './editor/prBus';
import { focusedGroup } from './workspace/layoutStore';
import { useGroupView, useUiTick } from './workspace/panes';

const BTN = 'ml-2 text-muted-foreground [-webkit-app-region:no-drag]';

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
  const rich = useRichUi((s) => !!gid && !!s.byGid[gid]?.on); // the rendered diff has no side by side / inline
  const hideComments = useHideComments((s) => s.hidden);
  const dd = gid ? diffs.get(gid) : undefined;
  if (!gid || !dd || !views[gid]?.diff) return null;
  const snapshot = dd.mode === 'o'; // a read-only copy of an old side: nothing to compare or flip
  return (
    <>
      {!snapshot && (
        <Button
          variant="ghost"
          size="xs"
          className={BTN}
          disabled={!dd.hasOrig}
          title="Open the old side in a read-only editor tab"
          onClick={() => openDiffOriginal()}
        >
          Open original
        </Button>
      )}
      <Button
        variant="ghost"
        size="xs"
        className={BTN}
        disabled={!dd.hasFile}
        title="Open the file in the editor (cmd+option+d)"
        onClick={() => openDiffFile()}
      >
        Open file
      </Button>
      {dd.mode === 'r' && (
        <Button
          variant="ghost"
          size="xs"
          className={BTN}
          aria-pressed={hideComments}
          title={hideComments ? 'Show review comments in the editor' : 'Hide review comments in the editor'}
          onClick={() => useHideComments.setState({ hidden: !hideComments })}
        >
          {hideComments ? 'Show comments' : 'Hide comments'}
        </Button>
      )}
      {!snapshot && !rich && (
        <Button
          variant="ghost"
          size="xs"
          className={`${BTN}${dd.inline ? ' text-primary' : ''}`}
          title={dd.inline ? 'Show diff side by side' : 'Show diff in a single editor (inline)'}
          onClick={() => {
            toggleInlineDiff(dd);
            bump();
          }}
        >
          {dd.inline ? 'Inline' : 'Side by side'}
        </Button>
      )}
    </>
  );
}
