// Source-agnostic view-zone host for review diffs: draws a source's threads (PR only), items and the gutter composer
// as React view zones in a Monaco diff editor. PR review plugs in through `prZoneSource` (editor/prThreads.tsx);
// local review supplies items + a composer handler and no threads.
import type * as Monaco from 'monaco-editor';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer, type ComposerState, type ComposerSubmit, emptyComposer, type Side } from './Composer';
import { registerReviewDiff } from './reveal';

/** Something drawn below a line: `render` gets `fit`, to call when its height changes. */
export interface ZoneEntry {
  key: string;
  side: Side;
  line: number;
  render: (fit: () => void) => ReactNode;
}

/** A review item placed in the diff (LEFT goes in the original editor, anything else in the modified one). */
export interface ZoneItem {
  id: string;
  path: string;
  line: number;
  side?: Side;
}

/** Gutter click / drag on a line number opens the composer; the source decides what submitting does. */
export interface ZoneComposer {
  /** sides whose gutter opens it (local review: RIGHT only) */
  sides: Side[];
  /** resolve true to close the composer (false keeps the draft, e.g. after a failed request) */
  submit: (c: ComposerSubmit) => Promise<boolean>;
  placeholder?: string;
  /** default "Add to review" */
  submitLabel?: string;
}

/** What a review kind supplies to `showReviewZones`. One instance per diff editor (it may keep per-diff state). */
export interface ReviewZoneSource<I extends ZoneItem = ZoneItem> {
  /** reveal namespace (`revealReviewLine(kind, ...)`), e.g. 'pr' or 'local' */
  kind: string;
  /** start loading and listening; call `changed` whenever items / threads / readiness change. Returns the unsubscribe */
  subscribe: (changed: () => void) => () => void;
  /** nothing (zones or composer) is drawn until this is true; default always ready */
  ready?: () => boolean;
  /** items to draw on `rel` (already filtered, e.g. open only), drawn after the threads */
  items: (rel: string) => I[];
  renderItem: (item: I, fit: () => void) => ReactNode;
  /** discussion threads on `rel` (PR only) */
  threads?: (rel: string) => ZoneEntry[];
  /** omit for no gutter composer */
  composer?: ZoneComposer;
}

/** Draw `source`'s threads, items and composer on `rel` (relative to `root`) in the diff editor; returns the cleanup. */
export function showReviewZones<I extends ZoneItem>(
  diff: Monaco.editor.IStandaloneDiffEditor,
  root: string,
  rel: string,
  source: ReviewZoneSource<I>,
): () => void {
  let dead = false;
  let clear = () => {};
  let composer: { side: Side; start: number; end: number } | null = null;
  let composerState: ComposerState = emptyComposer();
  const ready = () => source.ready?.() ?? true;
  const editorOf = (side: Side | undefined) => (side === 'LEFT' ? diff.getOriginalEditor() : diff.getModifiedEditor());
  const zoneFor = (
    ed: Monaco.editor.ICodeEditor,
    wantLine: number,
    node: (fit: () => void) => ReactNode,
    undo: (() => void)[],
  ) => {
    const model = ed.getModel();
    if (!model) return;
    const line = Math.min(Math.max(1, wantLine), model.getLineCount());
    const dom = document.createElement('div');
    dom.className = 'z-10 box-border px-4 pt-1.5 pb-1.5';
    dom.style.userSelect = 'text';
    const zone: Monaco.editor.IViewZone = {
      afterLineNumber: line,
      heightInPx: 60,
      domNode: dom,
      suppressMouseDown: false,
    };
    let id = '';
    const fit = () => {
      const h = (dom.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0;
      if (id && h && h + 12 !== zone.heightInPx) {
        zone.heightInPx = h + 12;
        ed.changeViewZones((a) => a.layoutZone(id));
      }
    };
    ed.changeViewZones((a) => {
      id = a.addZone(zone);
    });
    const r = createRoot(dom);
    r.render(node(fit));
    undo.push(() => {
      try {
        ed.changeViewZones((a) => a.removeZone(id));
      } catch {
        /* editor already disposed */
      }
      setTimeout(() => r.unmount());
    });
  };
  const draw = () => {
    clear();
    if (dead || !ready()) return;
    const undo: (() => void)[] = [];
    for (const t of source.threads?.(rel) ?? []) zoneFor(editorOf(t.side), t.line, t.render, undo);
    for (const it of source.items(rel)) zoneFor(editorOf(it.side), it.line, (fit) => source.renderItem(it, fit), undo);
    const comp = source.composer;
    if (composer && comp) {
      const c = composer;
      const ed = editorOf(c.side);
      const model = ed.getModel();
      const oldText = model
        ? model.getValueInRange({
            startLineNumber: c.start,
            startColumn: 1,
            endLineNumber: c.end,
            endColumn: model.getLineMaxColumn(c.end),
          })
        : '';
      zoneFor(
        ed,
        c.end,
        (fit) => (
          <Composer
            path={rel}
            side={c.side}
            startLine={c.start}
            line={c.end}
            oldText={oldText}
            state={composerState}
            onState={(st) => {
              composerState = st;
            }}
            onSubmit={comp.submit}
            placeholder={comp.placeholder}
            submitLabel={comp.submitLabel}
            onCancel={() => {
              composer = null;
              draw();
            }}
            onDone={() => {
              composer = null;
              composerState = emptyComposer();
              draw();
            }}
            onSize={fit}
          />
        ),
        undo,
      );
    }
    clear = () => {
      for (const u of undo) u();
      clear = () => {};
    };
  };
  // click a line number (or drag over several) to comment on it; the side is the editor that was clicked
  const gutter = (ed: Monaco.editor.ICodeEditor, side: Side) => {
    let down: number | null = null;
    const GUTTER_LINE_NUMBERS = 3; // monaco.editor.MouseTargetType
    const d1 = ed.onMouseDown((e) => {
      down = e.target.type === GUTTER_LINE_NUMBERS && e.target.position ? e.target.position.lineNumber : null;
    });
    const d2 = ed.onMouseUp((e) => {
      if (down == null || !ready()) return;
      const a = down;
      down = null;
      const b = e.target.position?.lineNumber ?? a;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      if (!composer || composer.side !== side || composer.start !== start || composer.end !== end)
        composerState = emptyComposer();
      composer = { side, start, end };
      draw();
    });
    return () => {
      d1.dispose();
      d2.dispose();
    };
  };
  const sides = source.composer?.sides ?? [];
  const offGutter = [
    ...(sides.includes('LEFT') ? [gutter(diff.getOriginalEditor(), 'LEFT')] : []),
    ...(sides.includes('RIGHT') ? [gutter(diff.getModifiedEditor(), 'RIGHT')] : []),
  ];
  const unreg = registerReviewDiff(source.kind, root, rel, diff);
  const unsub = source.subscribe(draw);
  return () => {
    dead = true;
    unsub();
    for (const o of offGutter) o();
    unreg();
    clear();
  };
}
