// Body of a mermaid diagram tab ('m:<path>#<n>', see mermaidTab.ts): the block's code on the left — the markdown
// file's own Monaco model with every other line hidden, so save / undo / dirty are the file's — and its live pele
// diagram (pan / zoom) on the right.
import { FileWarningIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { enableZoom, render, type Zoom } from 'pele';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/ui/empty';
import { Item, ItemContent, ItemDescription } from '@/ui/item';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/ui/resizable';
import { theme } from '../../lib/theme';
import { models } from '../../lsp/models';
import { base } from '../../lsp/protocol';
import { closeKey } from '../workspace/layoutStore';
import { markFocused } from '../workspace/panes';
import { addAppKeys, currentEditor, extraEditors, fontOpts, setCurrentEditor, wordWrapOpt } from './host';
import { type Block, innerText, mermaidEditors, trackerOf, useMermaidTabs } from './mermaidTab';

declare const monaco: typeof Monaco;
type Ed = Monaco.editor.IStandaloneCodeEditor;
type Model = Monaco.editor.ITextModel;

/** Editor view state per tracker (survives tab switches, which remount the pane). */
const viewStates = new WeakMap<object, Monaco.editor.ICodeEditorViewState | null>();

export function MermaidPane({ gid, k }: { gid: string; k: string | null }) {
  if (!k?.startsWith('m:')) return null;
  return <MermaidTab gid={gid} k={k} />;
}

function MermaidTab({ gid, k }: { gid: string; k: string }) {
  const info = useMermaidTabs((s) => s.byKey[k]);
  const model = info && !info.loading ? models.get(info.path)?.model : null;
  if (!info || info.loading) return <div className="absolute inset-0 bg-[var(--editor)]" />;
  if (!info.block || !model)
    return (
      <Empty className="absolute inset-0 border-0 bg-[var(--editor)]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileWarningIcon />
          </EmptyMedia>
          <EmptyTitle>Diagram block no longer exists</EmptyTitle>
          <EmptyDescription>
            {info.error
              ? `${base(info.path)}: ${info.error}`
              : `Diagram ${info.n} of ${base(info.path)} was removed or its fence is broken.`}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" size="sm" onClick={() => closeKey(k)}>
            Close
          </Button>
        </EmptyContent>
      </Empty>
    );
  return (
    <div className="absolute inset-0 bg-[var(--editor)]">
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel defaultSize="40" minSize={160}>
          <CodePane gid={gid} k={k} model={model} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={160}>
          <DiagramPane src={innerText(model, info.block)} id={`${gid}-${info.n}`} />
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}

/** First and last line the code pane shows: the block's inner lines (its fences when it is empty). */
const shownLines = (b: Block): [number, number] =>
  b.close - b.open > 1 ? [b.open + 1, b.close - 1] : [b.open, b.close];

function CodePane({ gid, k, model }: { gid: string; k: string; model: Model }) {
  const el = useRef<HTMLDivElement>(null);
  const keyRef = useRef(k);
  keyRef.current = k;
  const edRef = useRef<Ed | null>(null);

  useEffect(() => {
    const host = el.current as HTMLDivElement;
    const tracker = trackerOf(keyRef.current);
    const ed = monaco.editor.create(host, {
      model,
      theme: theme.monaco().id,
      automaticLayout: true,
      ...fontOpts(),
      wordWrap: wordWrapOpt(),
      minimap: { enabled: false },
      folding: false, // folding owns hidden areas too
      glyphMargin: false,
      lineDecorationsWidth: 6,
      lineNumbersMinChars: 3,
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      cursorStyle: 'block',
      cursorBlinking: 'blink',
      bracketPairColorization: { enabled: true },
      padding: { top: 8 },
      fixedOverflowWidgets: true,
      renderWhitespace: 'selection',
      tabSize: 2,
      insertSpaces: true,
      wordBasedSuggestions: 'off',
      'semanticHighlighting.enabled': false,
      links: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    });
    edRef.current = ed;
    extraEditors.add(ed);
    mermaidEditors.set(gid, ed);
    addAppKeys(ed);

    let range: [number, number] = [1, 1];
    /** Hide every line outside the block; recomputed on every content change. */
    const sync = () => {
      const b = trackerOf(keyRef.current)?.block;
      if (!b || model.isDisposed()) return;
      const [a, z] = shownLines(b);
      range = [a, z];
      const last = model.getLineCount();
      const hide: Monaco.IRange[] = [];
      if (a > 1) hide.push(new monaco.Range(1, 1, a - 1, 1));
      if (z < last) hide.push(new monaco.Range(z + 1, 1, last, 1));
      // setHiddenAreas exists on the code editor at runtime (folding uses it) but isn't in the public typings
      (ed as unknown as { setHiddenAreas(r: Monaco.IRange[], source?: unknown): void }).setHiddenAreas(
        hide,
        'tawny.mermaid',
      );
      clamp();
    };
    /** Keep cursors / selections inside the shown lines (undo or select-all would reach into hidden ones). */
    const clamp = () => {
      const sels = ed.getSelections();
      if (!sels) return;
      const [a, z] = range;
      const fix = (l: number, c: number): [number, number] =>
        l < a ? [a, 1] : l > z ? [z, model.getLineMaxColumn(z)] : [l, c];
      let changed = false;
      const next = sels.map((s) => {
        const [sl, sc] = fix(s.selectionStartLineNumber, s.selectionStartColumn);
        const [pl, pc] = fix(s.positionLineNumber, s.positionColumn);
        if (
          sl !== s.selectionStartLineNumber ||
          sc !== s.selectionStartColumn ||
          pl !== s.positionLineNumber ||
          pc !== s.positionColumn
        )
          changed = true;
        return new monaco.Selection(sl, sc, pl, pc);
      });
      if (changed) ed.setSelections(next);
    };
    sync();
    const vs = tracker && viewStates.get(tracker);
    if (vs) ed.restoreViewState(vs);
    else {
      ed.setPosition({ lineNumber: range[0], column: 1 });
      ed.revealLineNearTop(range[0], monaco.editor.ScrollType.Immediate);
    }
    clamp();
    const subs = [
      model.onDidChangeContent(() => sync()), // registered after the tracker's own listener: its block is current
      ed.onDidChangeCursorSelection(() => clamp()),
      ed.onKeyDown((e) => {
        // joining the first / last shown line with a (hidden) fence line would break the fence
        const s = ed.getSelection();
        if (!s?.isEmpty()) return;
        const [a, z] = range;
        const atStart = s.positionLineNumber === a && s.positionColumn === 1;
        const atEnd = s.positionLineNumber === z && s.positionColumn === model.getLineMaxColumn(z);
        if ((e.keyCode === monaco.KeyCode.Backspace && atStart) || (e.keyCode === monaco.KeyCode.Delete && atEnd)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }),
      ed.onDidFocusEditorWidget(() => {
        markFocused(gid);
        setCurrentEditor(ed);
      }),
    ];
    // select all = the block's code
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyA, () => {
      const [a, z] = range;
      ed.setSelection(new monaco.Range(a, 1, z, model.getLineMaxColumn(z)));
    });
    return () => {
      const t = trackerOf(keyRef.current);
      if (t) viewStates.set(t, ed.saveViewState());
      for (const s of subs) s.dispose();
      extraEditors.delete(ed);
      if (mermaidEditors.get(gid) === ed) mermaidEditors.delete(gid);
      if (currentEditor() === ed) setCurrentEditor(null);
      ed.dispose(); // never the model: it is the markdown file's
      edRef.current = null;
    };
  }, [gid, model]);

  return <div ref={el} className="h-full w-full" />;
}

/** Live diagram: re-rendered 250ms after the code stops changing, keeping zoom / pan; the last good one stays on error. */
function DiagramPane({ src, id }: { src: string; id: string }) {
  const box = useRef<HTMLDivElement>(null);
  const zoom = useRef<Zoom | null>(null);
  const lastSvg = useRef('');
  const first = useRef(true);
  const [err, setErr] = useState('');

  /** Put `svg` on screen: a fresh element (refit) unless zoomed in, where the old element keeps its viewBox. */
  const show = (svg: string, refit: boolean) => {
    const el = box.current;
    const z = zoom.current;
    if (!el || !z) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = svg.trim();
    const fresh = tpl.content.firstElementChild;
    if (!fresh) return;
    const old = el.firstElementChild?.localName === 'svg' ? el.firstElementChild : null;
    if (old && !refit && Math.abs(z.scale - z.fit) > 1e-3) {
      // zoomed: swap the drawing inside the element pele zooms (its viewBox / size are the zoom state)
      for (const a of [...fresh.attributes])
        if (!['viewBox', 'style', 'width', 'height', 'tabindex'].includes(a.name)) old.setAttribute(a.name, a.value);
      old.replaceChildren(...fresh.childNodes);
      return;
    }
    if (old) old.replaceWith(fresh);
    else el.prepend(fresh);
    z.refresh();
  };

  useEffect(() => {
    const z = enableZoom(box.current as HTMLDivElement, { always: true, maxScale: 8 });
    zoom.current = z;
    return () => {
      z.destroy();
      zoom.current = null;
    };
  }, []);

  useEffect(() => {
    const draw = () => {
      if (!src.trim()) {
        setErr('Empty diagram');
        return;
      }
      try {
        const { svg } = render(src, { idPrefix: `mmdtab-${id}-` });
        lastSvg.current = svg;
        show(svg, false);
        setErr('');
      } catch (e) {
        setErr((e as Error)?.message || String(e));
      }
    };
    if (first.current) {
      first.current = false;
      draw();
      return;
    }
    const t = setTimeout(draw, 250);
    return () => clearTimeout(t);
  }, [src, id]);

  return (
    <div className="mmd-diagram relative h-full w-full overflow-hidden">
      <div ref={box} className="mmd-canvas" />
      <Button
        variant="outline"
        size="xs"
        className="absolute top-2 left-2 z-10"
        title="Fit the diagram to the pane"
        onClick={() => lastSvg.current && show(lastSvg.current, true)}
      >
        Fit
      </Button>
      {err && (
        <Item
          variant="muted"
          size="sm"
          className="absolute inset-x-0 bottom-0 z-10 rounded-none border-0 bg-muted py-1.5"
        >
          <ItemContent>
            <ItemDescription className="line-clamp-3 font-mono text-destructive text-xs whitespace-pre-wrap">
              {err}
            </ItemDescription>
          </ItemContent>
        </Item>
      )}
    </div>
  );
}
