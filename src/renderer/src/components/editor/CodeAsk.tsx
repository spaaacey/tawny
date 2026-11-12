// Message boxes in view zones just below a selection's last line: the code below is pushed down rather than covered,
// so all of it stays visible. Opened by host.openAsk (via sendSelectionToAgent), any number per file, and they stay until
// sent or closed (the x). The box is a card like a PR review thread: its header (chevron, target, and when collapsed the
// saved text on one line) collapses and expands it, hovering it lights the selected code. Expanded it holds a small
// markdown editor (review/ComposeCard, shared with the diff comment composer): cmd+enter sends (a PR comment or a message
// to the agent), escape discards unsaved changes, cmd+w deletes (bridge.ts), shift+tab cycles agents, ending in a
// "new agent" slot that opens one in the pane to the right; Save keeps the text and collapses. Over the rich markdown view the box lives in the left margin
// instead (collapsed, inline above its text). Each box tracks its lines through edits.
import type { Editor } from '@tiptap/core';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/ui/button';
import { askAgent, askNewAgent } from '../../lib/actions';
import { addPrComment } from '../../lib/prAsk';
import { ComposeCard, mdOf } from '../review/ComposeCard';
import {
  type AskBox,
  closeBox,
  cycleBox,
  focusBox,
  minimiseBox,
  NEW_AGENT,
  PR_COMMENT,
  patchBox,
  pickBox,
  useAsks,
  zoneDom,
} from './askStore';
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
  const edRef = useRef<Editor | null>(null);
  const zone = useRef<{ id: string; z: { afterLineNumber: number; heightInPx: number } } | null>(null);
  const agent = box.agents[box.idx];
  const [menu, setMenu] = useState(false);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const rich = useRichUi((s) => !!s.byGid[gid]?.on); // over a rich markdown view the box is a widget there, not a view zone

  const fit = () => {
    const cur = zone.current;
    const d = domRef.current;
    if (!cur || !d) return;
    cur.z.heightInPx = d.offsetHeight + 12;
    ed.changeViewZones((a) => a.layoutZone(cur.id));
  };
  const close = () => {
    closeBox(box.id, true);
    ed.focus();
  };
  const submit = () => {
    const e = edRef.current;
    const model = ed.getModel();
    if (!e || !model) return;
    const msg = mdOf(e);
    if (agent?.id === PR_COMMENT) {
      if (!msg.trim()) return;
      void addPrComment(box.path, box.a, box.b, msg).then((ok) => {
        if (!ok) return;
        closeBox(box.id);
        ed.focus();
      });
      return;
    }
    const ref = askContext(box.path, model, box.a, box.b);
    const id = agent?.id;
    closeBox(box.id);
    ed.focus();
    if (id === NEW_AGENT) askNewAgent(ref, msg, gid);
    else askAgent(ref, msg, id);
  };
  const minimise = () => {
    minimiseBox(box.id);
    ed.focus();
  };
  const save = () => {
    const text = edRef.current ? mdOf(edRef.current) : '';
    if (text) patchBox(box.id, { draft: text, saved: text });
    minimise();
  };
  // discard unsaved changes: back to the saved text, a never-saved box goes away
  const discard = () => {
    const cur = useAsks.getState().boxes.find((x) => x.id === box.id);
    if (!cur?.saved) return close();
    edRef.current?.commands.setContent(cur.saved, { contentType: 'markdown' });
    patchBox(box.id, { draft: cur.saved });
    fit();
  };

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
      if (id && z.afterLineNumber !== r.endLineNumber) {
        z.afterLineNumber = r.endLineNumber;
        ed.changeViewZones((acc) => acc.layoutZone(id));
      }
    });
    requestAnimationFrame(fit);
    return () => {
      sub.dispose();
      track.clear();
      zone.current = null;
      if (!id) return;
      try {
        ed.changeViewZones((acc) => acc.removeZone(id));
      } catch {
        /* editor already disposed */
      }
    };
  }, [ed, dom, box.id, rich]);

  // a new box, or a jump from the sidebar list: move into it (the zone is laid out on Monaco's next render)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      fit();
      if (box.open && box.focusTick > 0 && edRef.current) {
        edRef.current.commands.focus('end');
        if (rich) dom.scrollIntoView({ block: 'nearest' });
        else ed.revealLineInCenterIfOutsideViewport(box.b);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [box.focusTick, box.open]);

  // hovering the header lights the selected code: Monaco decoration, or the marked blocks of the rich view
  const lit = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const light = (on: boolean) => {
    if (rich) {
      for (const el of document.querySelectorAll(`.ask-b-${box.id}`)) el.classList.toggle('ask-lit', on);
      return;
    }
    lit.current?.clear();
    lit.current = null;
    const model = ed.getModel();
    if (!on || !model) return;
    const last = Math.min(box.b, model.getLineCount());
    lit.current = ed.createDecorationsCollection([
      {
        range: { startLineNumber: box.a, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) },
        options: { isWholeLine: true, className: 'ask-hl' },
      },
    ]);
  };
  useEffect(() => () => lit.current?.clear(), []);
  // collapsed over the rich view the bar sits inline above its text instead of floating in the margin
  useEffect(() => {
    dom.classList.toggle('ask-collapsed', !box.open);
  }, [dom, box.open]);

  const summary = (box.saved || box.draft).trim().split('\n')[0];
  return createPortal(
    <ComposeCard
      boxId={box.id}
      cardRef={domRef}
      editorRef={edRef}
      title={agent?.label}
      open={box.open}
      onOpenChange={(o) => (o ? focusBox(box.id) : minimise())}
      summary={summary}
      onClose={() => {
        light(false);
        close();
      }}
      closeTitle="Delete (cmd+w)"
      onHover={light}
      initial={box.draft}
      onChange={(md) => {
        patchBox(box.id, { draft: md });
        fit();
      }}
      placeholder={() =>
        agentRef.current?.id === PR_COMMENT
          ? 'Comment on this selection (draft on the PR)…'
          : 'Message agent about this selection…'
      }
      tools={
        <div className="ask-agent-wrap" hidden={!agent}>
          <Button
            variant="ghost"
            size="xs"
            className="h-auto max-w-full min-w-0 gap-1.5 bg-accent px-2 py-0.5 text-[11.5px] font-normal text-muted-foreground"
            title={box.agents.length > 1 ? 'Choose target (shift+tab: next)' : ''}
            onClick={() => setMenu((m) => !m)}
          >
            <i className={`sdot${agent?.waiting ? ' wait' : agent?.working ? ' work' : ''}`} />
            <span>{agent?.label}</span>
            {box.agents.length > 1 && <b>▾</b>}
          </Button>
          {menu && (
            <div className="ask-menu">
              {box.agents.map((t, i) => (
                <Button
                  variant="ghost"
                  size="xs"
                  key={t.id}
                  className={`h-auto w-full justify-start px-2 py-1 text-[11.5px] font-normal${i === box.idx ? ' on bg-accent' : ''}`}
                  onClick={() => {
                    pickBox(box.id, i);
                    setMenu(false);
                    edRef.current?.commands.focus();
                  }}
                >
                  <i className={`sdot${t.waiting ? ' wait' : t.working ? ' work' : ''}`} />
                  <span>{t.label}</span>
                </Button>
              ))}
            </div>
          )}
        </div>
      }
      submitLabel={agent?.id === PR_COMMENT ? 'Comment' : 'Send'}
      onSubmit={submit}
      onSave={save}
      onDiscard={discard}
      onCycle={() => cycleBox(box.id)}
    />,
    dom,
  );
}
