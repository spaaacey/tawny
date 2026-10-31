// Message boxes in view zones just below a selection's last line: the code below is pushed down rather than covered,
// so all of it stays visible. Opened by host.openAsk (via sendSelectionToAgent), any number per file, and they stay until
// sent or closed (the x). The box is a small markdown editor (Tiptap, like the rich view: ``` makes a highlighted code
// block, enter is a newline): cmd+enter saves, cmd+option+enter sends, escape discards unsaved changes, cmd+w deletes
// (bridge.ts), shift+tab cycles agents, ending in a "new agent" slot that opens one in the pane to the right. Every box,
// open or minimised, has an
// icon pinned at the editor's right edge, left of the scrollbar, level with the top of its selection (hover lights the selected code; boxes starting on the same line
// share one icon with a count). Over the rich markdown view the box lives in the left margin instead. Each box tracks its
// lines through edits.
import { Editor } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { askAgent, askNewAgent } from '../../lib/actions';
import {
  type AskBox,
  closeBox,
  cycleBox,
  focusBox,
  isNote,
  minimiseBox,
  NEW_AGENT,
  NOTE,
  patchBox,
  useAsks,
  zoneDom,
} from './askStore';
import { type AskEd, askContext, lineHeightPx, useAskShown, useRichUi } from './host';

const lowlight = createLowlight(common);
const mdOf = (e: Editor) => e.getMarkdown().trim();

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

/** Icons of the boxes, open or minimised (one per start line, counting the boxes there), pinned to the editor's right edge
 * beside the scrollbar so they take no gutter width; hovering one lights the selected code. */
function AskGutter({ ed, boxes }: { ed: AskEd; boxes: AskBox[] }) {
  const [hover, setHover] = useState(0);
  const [, relayout] = useState(0);
  const byLine = new Map<number, AskBox[]>();
  for (const b of boxes) byLine.set(b.a, [...(byLine.get(b.a) ?? []), b]);
  const linesRef = useRef(byLine);
  linesRef.current = byLine;
  useEffect(() => {
    const model = ed.getModel();
    if (!model) return;
    const decos: Monaco.editor.IModelDeltaDecoration[] = [];
    for (const b of linesRef.current.get(hover) ?? []) {
      const last = Math.min(b.b, model.getLineCount());
      decos.push({
        range: { startLineNumber: b.a, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) },
        options: { isWholeLine: true, className: 'ask-hl' },
      });
    }
    const c = ed.createDecorationsCollection(decos);
    return () => c.clear();
  }, [ed, hover]);

  useEffect(() => {
    const bump = () => relayout((n) => n + 1);
    const subs = [ed.onDidScrollChange(bump), ed.onDidContentSizeChange(bump), ed.onDidLayoutChange(bump)];
    return () => {
      for (const d of subs) d.dispose();
      setHover(0);
    };
  }, [ed]);

  const root = ed.getDomNode();
  if (!root) return null;
  const h = lineHeightPx();
  const view = ed.getLayoutInfo().height;
  return createPortal(
    <>
      {[...byLine].map(([line, g]) => {
        const top = ed.getTopForLineNumber(line) - ed.getScrollTop();
        if (top + h < 0 || top > view) return null;
        return (
          <div
            key={line}
            className={`ask-glyph ask-pin ask-n${Math.min(g.length, 9)}${g.every(isNote) ? ' ask-note' : ''}`}
            style={{ top, height: h, '--pin': `${Math.round(h / 1.6)}px` } as React.CSSProperties}
            onMouseEnter={() => setHover(line)}
            onMouseLeave={() => setHover(0)}
            onMouseDown={(e) => {
              e.preventDefault(); // Monaco would focus the editor and steal focus from the box
              e.stopPropagation();
              if (g.some((b) => b.open)) for (const b of g) minimiseBox(b.id);
              else focusBox(...g.map((b) => b.id));
            }}
          />
        );
      })}
    </>,
    root,
  );
}

function AskBoxView({ gid, box, ed, group }: { gid: string; box: AskBox; ed: AskEd; group: AskBox[] }) {
  const dom = zoneDom(box.id);
  const domRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const edRef = useRef<Editor | null>(null);
  const zone = useRef<{ id: string; z: { afterLineNumber: number; heightInPx: number } } | null>(null);
  const agent = box.agents[box.idx];
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
    if (agent?.id === NOTE) return save();
    const msg = mdOf(e);
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
  const saveRef = useRef(save);
  saveRef.current = save;
  const discardRef = useRef(discard);
  discardRef.current = discard;
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

  // the markdown editor lives while the box is expanded
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !box.open) return;
    const e = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({ codeBlock: false, heading: false, link: { openOnClick: false, autolink: true } }),
        CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
        Markdown,
        Placeholder.configure({
          placeholder: () =>
            agentRef.current?.id === NOTE
              ? 'Note on this selection (not sent)…'
              : 'Message agent about this selection…',
        }),
      ],
      content: useAsks.getState().boxes.find((x) => x.id === box.id)?.draft ?? '',
      contentType: 'markdown',
      onUpdate: ({ editor }) => {
        patchBox(box.id, { draft: mdOf(editor) });
        fit();
      },
      editorProps: { attributes: { spellcheck: 'false' } },
    });
    edRef.current = e;
    return () => {
      edRef.current = null;
      e.destroy();
    };
  }, [box.id, box.open]);

  // native listeners: Monaco's own handlers sit above this node and must not see these events
  useEffect(() => {
    const d = domRef.current;
    const host = hostRef.current;
    if (!d || !host) return;
    const onDown = (e: MouseEvent) => {
      e.stopPropagation(); // Monaco's pointer handling would pull focus back into the editor
      const t = e.target as HTMLElement;
      if (!host.contains(t) && !t.closest('button')) e.preventDefault(); // keep focus where it is
    };
    const stop = (e: Event) => e.stopPropagation();
    // capture: our keys win over the editor's own (shift+tab would lift a list item)
    const onKeyCapture = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) submitRef.current();
        else saveRef.current();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        cycleBox(box.id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        discardRef.current();
      }
    };
    d.addEventListener('mousedown', onDown);
    d.addEventListener('pointerdown', stop);
    host.addEventListener('keydown', onKeyCapture, true);
    host.addEventListener('keydown', stop);
    return () => {
      d.removeEventListener('mousedown', onDown);
      d.removeEventListener('pointerdown', stop);
      host.removeEventListener('keydown', onKeyCapture, true);
      host.removeEventListener('keydown', stop);
    };
  }, [box.id, box.open]);

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
        className={`ask-chip${group.every(isNote) ? ' ask-note' : ''}`}
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
    <div className="rich-ask" ref={domRef} data-box={box.id}>
      <button type="button" className="ask-min" title="Collapse" onClick={minimise}>
        –
      </button>
      <button type="button" className="ask-close" title="Delete (cmd+w)" onClick={close}>
        ✕
      </button>
      <div className="ask-md rich-doc" ref={hostRef} />
      <div className="ask-foot">
        <span className="ask-agent" hidden={!agent} title={box.agents.length > 1 ? 'shift+tab: next agent' : ''}>
          <i className={`sdot${agent?.waiting ? ' wait' : agent?.working ? ' work' : ''}`} />
          <span>{agent?.label}</span>
        </span>
        <button type="button" className={agent?.id === NOTE ? 'ask-send' : 'ask-save'} onClick={save}>
          Save <kbd>⌘↵</kbd>
        </button>
        {agent?.id !== NOTE && (
          <button type="button" className="ask-send" onClick={submit}>
            Send <kbd>⌘⌥↵</kbd>
          </button>
        )}
      </div>
    </div>,
    dom,
  );
}
