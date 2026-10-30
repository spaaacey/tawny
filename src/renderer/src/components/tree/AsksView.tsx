// Secondary sidebar tab listing the open ask boxes (selection message boxes) of the worktree: click one to jump to it.
import { iconSrc } from '../../lib/fileicons';
import { openFile } from '../editor/api';
import { type AskBox, closeBox, focusBox, useAsks } from '../editor/askStore';
import { baseName, relTo, useTree } from './store';

export const useOpenAsks = () => {
  const root = useTree((s) => s.root);
  const boxes = useAsks((s) => s.boxes);
  return root ? boxes.filter((b) => b.path.startsWith(`${root}/`)) : [];
};

async function jump(b: AskBox) {
  await openFile(b.path);
  setTimeout(() => focusBox(b.id), 60); // the editor mounts the box once the file is shown
}

export function AsksView() {
  const root = useTree((s) => s.root);
  const boxes = useOpenAsks();
  if (!boxes.length)
    return (
      <div className="center-msg">
        <div className="empty-title">No open asks</div>
        <div>Select code and press cmd+opt+l to message an agent about it.</div>
      </div>
    );
  return (
    <div className="asks-list">
      {boxes.map((b) => (
        <div key={b.id} className="asks-row" onClick={() => jump(b)} title={b.path}>
          <div className="asks-head">
            <img alt="" src={iconSrc(baseName(b.path), 'file')} width={14} height={14} />
            <span className="asks-file">{baseName(b.path)}</span>
            <span className="asks-lines">{b.a === b.b ? `L${b.a}` : `L${b.a}-${b.b}`}</span>
            <button
              type="button"
              className="asks-x"
              title="Close"
              onClick={(e) => {
                e.stopPropagation();
                closeBox(b.id);
              }}
            >
              ✕
            </button>
          </div>
          <div className="asks-rel">{relTo(root, b.path)}</div>
          <div className={`asks-draft${b.draft ? '' : ' empty'}`}>{b.draft.trim() || 'No message yet'}</div>
          <div className="asks-agent">{b.agents[b.idx]?.label}</div>
        </div>
      ))}
    </div>
  );
}
