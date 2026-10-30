// Message boxes in view zones just below a selection's last line: the code below is pushed down rather than covered,
// so all of it stays visible. Opened by host.openAsk (via sendSelectionToAgent), any number per file, and they stay until
// sent or closed (the x): enter saves and minimises (shift+enter is a newline, so is leaving the box), cmd+enter sends,
// shift+tab cycles agents, ending in a "new agent" slot that opens one in the pane to the right. A minimised box is an
// icon in the line-decorations gutter (right of the line numbers; the glyph margin belongs to breakpoints) at the top of its selection (hover lights the selected code; boxes starting on the same line
// share one icon with a count). Over the rich markdown view the box lives in the left margin instead. Each box tracks its
// lines through edits.
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { askAgent, askNewAgent } from '../../lib/actions';
import {
  type AskBox,
  closeBox,
  cycleBox,
  focusBox,
  minimiseBox,
  NEW_AGENT,
  patchBox,
  useAsks,
  zoneDom,
} from './askStore';
import { type AskEd, askContext, useAskShown, useRichUi } from './host';

/** Boxes of the file the group shows. */
export function CodeAsk({ gid }: { gid: string }) {
  const shown = useAskShown((s) => s.byGid[gid]);
  const boxes = useAsks((s) => s.boxes);
  const rich = useRichUi((s) => !!s.byGid[gid]?.on);
  if (!shown) return null;
  const mine = boxes.filter((b) => b.path === shown.path);
  return (
    <>
      {!rich && <AskGutter ed={shown.ed} boxes={mine} />}
      {mine.map((b) => (
        <AskBoxView
          key={`${shown.path}:${b.id}`}
          gid={gid}
          box={b}
          ed={shown.ed}
          group={mine.filter((x) => !x.open && !b.open && x.a === b.a)}
        />
      ))}
    </>
  );
}

/** Gutter icons of the minimised boxes (one per start line, counting the boxes there) and the hover highlight. */
function AskGutter({ ed, boxes }: { ed: AskEd; boxes: AskBox[] }) {
  const [hover, setHover] = useState(0);
  const byLine = new Map<number, AskBox[]>();
  for (const b of boxes) if (!b.open) byLine.set(b.a, [...(byLine.get(b.a) ?? []), b]);
  const linesRef = useRef(byLine);
  linesRef.current = byLine;
  const any = byLine.size > 0;
  // widen the decorations strip to fit an icon (unless something, e.g. the blame gutter, already made it wider)
  useEffect(() => {
    if (!any) return;
    const cur = ed.getOption(window.monaco.editor.EditorOption.lineDecorationsWidth) as number;
    if (cur >= 22) return;
    ed.updateOptions({ lineDecorationsWidth: 22 });
    return () => ed.updateOptions({ lineDecorationsWidth: cur });
  }, [ed, any]);
  const sig = [...byLine].map(([l, g]) => `${l}:${g.length}:${Math.max(...g.map((b) => b.b))}`).join(',');
  useEffect(() => {
    const model = ed.getModel();
    if (!model) return;
    const decos: Monaco.editor.IModelDeltaDecoration[] = [...linesRef.current].map(([line, g]) => ({
      range: { startLineNumber: line, startColumn: 1, endLineNumber: line, endColumn: 1 },
      options: { linesDecorationsClassName: `ask-glyph ask-n${Math.min(g.length, 9)}` },
    }));
    for (const b of linesRef.current.get(hover) ?? []) {
      const last = Math.min(b.b, model.getLineCount());
      decos.push({
        range: { startLineNumber: b.a, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) },
        options: { isWholeLine: true, className: 'ask-hl' },
      });
    }
    const c = ed.createDecorationsCollection(decos);
    return () => c.clear();
  }, [ed, sig, hover]);

  useEffect(() => {
    const onGlyph = (t: { type: number; position: { lineNumber: number } | null }) =>
      t.type === 4 /* GUTTER_LINE_DECORATIONS */ && t.position && linesRef.current.has(t.position.lineNumber)
        ? t.position.lineNumber
        : 0;
    const subs = [ed.onMouseMove((e) => setHover(onGlyph(e.target))), ed.onMouseLeave(() => setHover(0))];
    // capture phase: on a foldable line Monaco's folding control covers the whole strip and would fold on this click
    const root = ed.getDomNode();
    const onDown = (e: MouseEvent) => {
      const icon = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.classList.contains('ask-glyph'));
      if (!icon || e.clientX < icon.getBoundingClientRect().right - 18) return;
      const line = onGlyph(ed.getTargetAtClientPoint(e.clientX, e.clientY) ?? { type: 0, position: null });
      const g = line ? linesRef.current.get(line) : undefined;
      if (!g) return;
      e.preventDefault(); // Monaco would focus the editor on mouseup and steal focus from the box
      e.stopPropagation();
      focusBox(...g.map((b) => b.id));
    };
    root?.addEventListener('mousedown', onDown, true);
    return () => {
      for (const d of subs) d.dispose();
      root?.removeEventListener('mousedown', onDown, true);
      setHover(0);
    };
  }, [ed]);

  return null;
}

function AskBoxView({ gid, box, ed, group }: { gid: string; box: AskBox; ed: AskEd; group: AskBox[] }) {
  const dom = zoneDom(box.id);
  const domRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const zone = useRef<{ id: string; z: { afterLineNumber: number; heightInPx: number } } | null>(null);
  const agent = box.agents[box.idx];
  const openedAt = useRef(0);
  openedAt.current = box.open ? openedAt.current || performance.now() : 0;
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
  const minimise = () => {
    minimiseBox(box.id);
    ed.focus();
  };
  const minimiseRef = useRef(minimise);
  minimiseRef.current = minimise;
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // the zone and the tracked range exist while the file is shown
  useEffect(() => {
    const model = ed.getModel();
    if (!model || rich) return;
    const { a, b } = useAsks.getState().boxes.find((x) => x.id === box.id) ?? box;
    const last = Math.min(b, model.getLineCount());
    const z = { afterLineNumber: last, heightInPx: 110, domNode: dom, suppressMouseDown: true };
    let id = '';
    if (box.open) {
      ed.changeViewZones((acc) => {
        id = acc.addZone(z);
      });
      zone.current = { id, z };
    }
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
  }, [ed, dom, box.id, box.open, rich]);

  // native listeners: Monaco's own handlers sit above this node and must not see these events
  useEffect(() => {
    const d = domRef.current;
    const ta = taRef.current;
    if (!d || !ta) return;
    const onDown = (e: MouseEvent) => {
      e.stopPropagation(); // Monaco's pointer handling would pull focus back into the editor
      if (e.target !== ta && !(e.target as HTMLElement).closest('button')) e.preventDefault(); // keep focus where it is
    };
    const stop = (e: Event) => e.stopPropagation();
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing && !e.shiftKey) {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) submitRef.current();
        else minimiseRef.current();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        cycleBox(box.id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        minimiseRef.current();
      }
    };
    d.addEventListener('mousedown', onDown);
    d.addEventListener('pointerdown', stop);
    ta.addEventListener('keydown', onKey);
    return () => {
      d.removeEventListener('mousedown', onDown);
      d.removeEventListener('pointerdown', stop);
      ta.removeEventListener('keydown', onKey);
    };
  }, [box.id, box.open]);

  // a new box, or a jump from the sidebar list: move into it (the zone is laid out on Monaco's next render)
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      grow();
      fit();
      if (box.open && box.focusTick > 0 && taRef.current) {
        taRef.current.focus();
        if (rich) dom.scrollIntoView({ block: 'nearest' });
        else ed.revealLineInCenterIfOutsideViewport(box.b);
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [box.focusTick, box.open]);

  if (!box.open) {
    // over the rich view the icon is part of the widget; in the code editor it is a glyph margin decoration
    if (!rich || group[0]?.id !== box.id) return null;
    const lit = (on: boolean) => {
      for (const x of group)
        for (const el of document.querySelectorAll(`.ask-b-${x.id}`)) el.classList.toggle('ask-lit', on);
    };
    return createPortal(
      <button
        type="button"
        className="ask-chip"
        title={group.map((x) => x.saved).join('\n')}
        onMouseOver={() => lit(true)}
        onMouseOut={() => lit(false)}
        onFocus={() => lit(true)}
        onBlur={() => lit(false)}
        onClick={() => {
          lit(false);
          focusBox(...group.map((x) => x.id));
        }}
      >
        {group.length > 1 && <span>{group.length}</span>}
      </button>,
      dom,
    );
  }

  return createPortal(
    <div className="rich-ask" ref={domRef}>
      <button type="button" className="ask-close" title="Delete" onClick={close}>
        ✕
      </button>
      <textarea
        ref={taRef}
        rows={2}
        placeholder="Message agent about this selection…"
        spellCheck={false}
        defaultValue={box.draft}
        onBlur={(e) => {
          // leaving the box (not its buttons, not the whole window) saves and minimises it
          if (domRef.current?.contains(e.relatedTarget as Node | null) || !document.hasFocus()) return;
          if (performance.now() - openedAt.current < 400) return; // focus churn while the icon click settles
          minimiseBox(box.id);
        }}
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
        <button type="button" className="ask-send" onClick={submit}>
          Send <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>,
    dom,
  );
}
