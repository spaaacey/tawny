// Message boxes in view zones just below a selection's last line: the code below is pushed down rather than covered,
// so all of it stays visible. Opened by host.openAsk (via sendSelectionToAgent), any number per file, and they stay until
// sent or closed: cmd+enter sends, escape (or the x) closes, shift+tab cycles agents, ending in a
// "new agent" slot that opens one in the pane to the right. Each box tracks its lines through edits.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { askAgent, askNewAgent } from '../../lib/actions';
import { type AskBox, closeBox, cycleBox, NEW_AGENT, patchBox, useAsks, zoneDom } from './askStore';
import { type AskEd, askContext, useAskShown, useRichUi } from './host';

/** Boxes of the file the group shows. */
export function CodeAsk({ gid }: { gid: string }) {
  const shown = useAskShown((s) => s.byGid[gid]);
  const boxes = useAsks((s) => s.boxes);
  if (!shown) return null;
  return (
    <>
      {boxes
        .filter((b) => b.path === shown.path)
        .map((b) => (
          <AskBoxView key={`${shown.path}:${b.id}`} gid={gid} box={b} ed={shown.ed} />
        ))}
    </>
  );
}

function AskBoxView({ gid, box, ed }: { gid: string; box: AskBox; ed: AskEd }) {
  const dom = zoneDom(box.id);
  const domRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const zone = useRef<{ id: string; z: { afterLineNumber: number; heightInPx: number } } | null>(null);
  const agent = box.agents[box.idx];
  const rich = useRichUi((s) => !!s.byGid[gid]?.on); // over a rich markdown view the box is a widget there, not a view zone

  const fit = () => {
    const cur = zone.current;
    const d = domRef.current;
    if (!cur || !d) return;
    cur.z.heightInPx = d.offsetHeight + 12;
    ed.changeViewZones((a) => a.layoutZone(cur.id));
  };
  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    fit();
  };
  const close = () => {
    closeBox(box.id);
    ed.focus();
  };
  const submit = () => {
    const ta = taRef.current;
    const model = ed.getModel();
    if (!ta || !model) return;
    const msg = ta.value.trim();
    const ref = askContext(box.path, model, box.a, box.b);
    const id = agent?.id;
    closeBox(box.id);
    ed.focus();
    if (id === NEW_AGENT) askNewAgent(ref, msg, gid);
    else askAgent(ref, msg, id);
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const closeRef = useRef(close);
  closeRef.current = close;

  // the zone and the tracked range exist while the file is shown
  useEffect(() => {
    const model = ed.getModel();
    if (!model || rich) return;
    const { a, b } = useAsks.getState().boxes.find((x) => x.id === box.id) ?? box;
    const last = Math.min(b, model.getLineCount());
    const z = { afterLineNumber: last, heightInPx: 110, domNode: dom, suppressMouseDown: true };
    let id = '';
    ed.changeViewZones((acc) => {
      id = acc.addZone(z);
    });
    zone.current = { id, z };
    // whole lines, not growing when typing at the edges: the range follows edits above and inside it
    const track = ed.createDecorationsCollection([
      {
        range: { startLineNumber: a, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) },
        options: { stickiness: 1 /* NeverGrowsWhenTypingAtEdges */ },
      },
    ]);
    const sub = track.onDidChange(() => {
      const r = track.getRange(0);
      if (!r) return;
      patchBox(box.id, { a: r.startLineNumber, b: r.endLineNumber });
      if (z.afterLineNumber !== r.endLineNumber) {
        z.afterLineNumber = r.endLineNumber;
        ed.changeViewZones((acc) => acc.layoutZone(id));
      }
    });
    requestAnimationFrame(fit);
    return () => {
      sub.dispose();
      track.clear();
      zone.current = null;
      try {
        ed.changeViewZones((acc) => acc.removeZone(id));
      } catch {
        /* editor already disposed */
      }
    };
  }, [ed, dom, box.id, rich]);

  // native listeners: Monaco's own handlers sit above this node and must not see these events
  useEffect(() => {
    const d = domRef.current;
    const ta = taRef.current;
    if (!d || !ta) return;
    const onDown = (e: MouseEvent) => {
      if (e.target !== ta && !(e.target as HTMLElement).closest('button')) e.preventDefault(); // keep focus where it is
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        submitRef.current();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        cycleBox(box.id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      }
    };
    d.addEventListener('mousedown', onDown);
    ta.addEventListener('keydown', onKey);
    return () => {
      d.removeEventListener('mousedown', onDown);
      ta.removeEventListener('keydown', onKey);
    };
  }, [box.id]);

  // a new box, or a jump from the sidebar list: move into it (the zone is laid out on Monaco's next render)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      grow();
      fit();
      if (box.focusTick > 0 && taRef.current) {
        taRef.current.focus();
        if (rich) dom.scrollIntoView({ block: 'nearest' });
        else ed.revealLineInCenterIfOutsideViewport(box.b);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [box.focusTick]);

  return createPortal(
    <div className="rich-ask" ref={domRef}>
      <textarea
        ref={taRef}
        rows={2}
        placeholder="Message agent about this selection…"
        spellCheck={false}
        defaultValue={box.draft}
        onInput={(e) => {
          patchBox(box.id, { draft: e.currentTarget.value });
          grow();
        }}
      />
      <div className="ask-foot">
        <span className="ask-agent" hidden={!agent} title={box.agents.length > 1 ? 'shift+tab: next agent' : ''}>
          <i className={`sdot${agent?.waiting ? ' wait' : agent?.working ? ' work' : ''}`} />
          <span>{agent?.label}</span>
        </span>
        <button type="button" className="ask-close" title="Close (escape)" onClick={close}>
          ✕
        </button>
        <button type="button" className="ask-send" onClick={submit}>
          Send <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>,
    dom,
  );
}
