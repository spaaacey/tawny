// Message boxes in view zones just below a selection's last line: the code below is pushed down rather than covered,
// so all of it stays visible. Opened by host.openAsk (via sendSelectionToAgent), any number per file, and they stay until
// sent or closed (the x). The box is a card like a PR review thread: its header (chevron, target, and when collapsed the
// saved text on one line) collapses and expands it, hovering it lights the selected code. Expanded it holds a small
// markdown editor (Tiptap, like the rich view: ``` makes a highlighted code block, enter is a newline): cmd+enter saves,
// cmd+option+enter sends, escape discards unsaved changes, cmd+w deletes (bridge.ts), shift+tab cycles agents, ending in a
// "new agent" slot that opens one in the pane to the right. Over the rich markdown view the box lives in the left margin
// instead (collapsed, inline above its text). Each box tracks its lines through edits.
import { Editor } from '@tiptap/core';
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Markdown } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { ChevronRightIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Kbd } from '@/ui/kbd';
import { askAgent, askNewAgent } from '../../lib/actions';
import { addPrComment } from '../../lib/prAsk';
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

const lowlight = createLowlight(common);
const mdOf = (e: Editor) => e.getMarkdown().trim();

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
  const hostRef = useRef<HTMLDivElement>(null);
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
            agentRef.current?.id === PR_COMMENT
              ? 'Comment on this selection (draft on the PR)…'
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
    <Collapsible open={box.open} onOpenChange={(o) => (o ? focusBox(box.id) : minimise())}>
      <Card className="rich-ask gap-0 py-0" ref={domRef} data-box={box.id}>
        <CollapsibleTrigger asChild>
          <CardHeader
            className="flex cursor-pointer flex-row items-center gap-2 py-1 pr-1.5 pl-3"
            onMouseEnter={() => light(true)}
            onMouseLeave={() => light(false)}
          >
            <ChevronRightIcon className={`size-3.5 flex-none transition-transform ${box.open ? 'rotate-90' : ''}`} />
            <span className="flex-none text-xs font-medium">{agent?.label}</span>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{box.open ? '' : summary}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground flex-none text-xs"
              title="Delete (cmd+w)"
              onClick={(e) => {
                e.stopPropagation();
                light(false);
                close();
              }}
            >
              ✕
            </Button>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-2 px-3.5 pt-0.5 pb-2.5">
            <div className="ask-md rich-doc" ref={hostRef} />
            <div className="ask-foot">
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
              <Button
                variant="secondary"
                size="sm"
                className="ml-auto h-auto flex-none gap-2 py-1 pr-2 pl-3 text-[12.5px] font-semibold"
                onClick={save}
              >
                Save <Kbd className="bg-black/20 text-inherit">⌘↵</Kbd>
              </Button>
              <Button
                size="sm"
                className="h-auto flex-none gap-2 py-1 pr-2 pl-3 text-[12.5px] font-semibold"
                onClick={submit}
              >
                {agent?.id === PR_COMMENT ? 'Comment' : 'Send'} <Kbd className="bg-black/20 text-inherit">⌘⌥↵</Kbd>
              </Button>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>,
    dom,
  );
}
