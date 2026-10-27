// React hosts for a group's Monaco editors. The editors themselves are created lazily by host.ts (show / showDiff)
// into per-group persistent elements (GroupReg.host / diffHost) so they outlive React remounts of the pane; these
// components adopt those elements, own their visibility, and render the pieces layered on top of the code editor.
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { type GroupReg, useGroupView } from '../workspace/panes';
import { CodeAsk } from './CodeAsk';
import { Crumbs } from './Crumbs';
import { diffs, editors, setRichFor, useEditorReady, useRichUi } from './host';

function RichToggle({ gid }: { gid: string }) {
  const s = useRichUi((x) => x.byGid[gid]);
  const on = !!s?.on;
  return (
    <div className="rich-toggle" hidden={!s?.able} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" className={on ? undefined : 'on'} onClick={() => setRichFor(gid, false)}>
        Source
      </button>
      <button type="button" className={on ? 'on' : undefined} onClick={() => setRichFor(gid, true)}>
        Rich
      </button>
    </div>
  );
}

/** Adopt a persistent host element, show / hide it, and re-layout Monaco when it becomes visible. */
function useHost(gid: string, host: HTMLElement, visible: boolean) {
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (slot.current && host.parentNode !== slot.current) slot.current.appendChild(host);
  });
  useLayoutEffect(() => {
    host.hidden = !visible;
    if (visible) {
      editors.get(gid)?.layout();
      diffs.get(gid)?.ed.layout();
    }
  }, [gid, host, visible]);
  return slot;
}

/** Code editor of a group + its image / binary placeholders. */
export function EditorPane({ gid, reg }: { gid: string; reg: GroupReg }) {
  const view = useGroupView((s) => s.views[gid]);
  const ready = useEditorReady((s) => !!s.ready[gid]);
  const slot = useHost(gid, reg.host, !!view?.editor);
  return (
    <>
      <div ref={slot} style={{ display: 'contents' }} />
      {ready &&
        createPortal(
          <>
            <Crumbs gid={gid} />
            <RichToggle gid={gid} />
          </>,
          reg.host,
        )}
      {ready && <CodeAsk gid={gid} />}
      {view?.image && (
        <div className="gimage">
          <img alt="" src={view.image} />
        </div>
      )}
      {view?.binary && (
        <div className="gbinary center-msg">
          <div className="empty-title">Binary file</div>
          <div>This file can&#39;t be shown as text.</div>
        </div>
      )}
    </>
  );
}

/** Diff editor of a group. */
export function DiffPane({ gid, reg }: { gid: string; reg: GroupReg }) {
  const view = useGroupView((s) => s.views[gid]);
  const slot = useHost(gid, reg.diffHost, !!view?.diff);
  return <div ref={slot} style={{ display: 'contents' }} />;
}
