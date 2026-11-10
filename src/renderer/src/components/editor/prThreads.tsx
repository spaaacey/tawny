// PR review threads, pending drafts, agent findings and the comment composer drawn as view zones in a PR file's diff ('d:r:' tabs), from the stored PrSnapshot.
import { ChevronRightIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import type { PrFinding, PrSnapshot, PrThread } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { CommentView, Composer, type ComposerState, prReview, ReplyBox, Sized } from '../workspace/PrDrafts';
import { FindingCard, isOutdated } from '../workspace/PrFindings';
import { onPrSnapshot } from './prBus';
import { registerPrDiff } from './prReveal';

function ThreadCard({
  t,
  dir,
  pendingId,
  onSize,
}: {
  t: PrThread;
  dir: string;
  pendingId?: string;
  onSize: () => void;
}) {
  const [open, setOpen] = useState(!t.isResolved);
  const [busy, setBusy] = useState(false);
  const isPending = (c: PrThread['comments'][number]) => !!pendingId && c.reviewId === pendingId;
  const hasPending = t.comments.some(isPending);
  const allPending = t.comments.every(isPending);
  return (
    <Sized onSize={onSize}>
      <Collapsible
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          requestAnimationFrame(onSize);
        }}
      >
        <Card className="gap-0 py-0">
          <CollapsibleTrigger asChild>
            <CardHeader className="flex cursor-pointer flex-row items-center gap-2 px-3 py-1.5">
              <ChevronRightIcon className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
              <span className="text-xs font-medium">{t.comments[0]?.author?.login}</span>
              {!open && (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{t.comments[0]?.body}</span>
              )}
              {open && <span className="flex-1" />}
              {hasPending && <Badge variant="secondary">Pending</Badge>}
              {t.isResolved && <Badge variant="secondary">Resolved</Badge>}
              {t.isOutdated && (
                <Badge variant="outline" title="The code changed since this comment; shown at its original line">
                  Outdated
                </Badge>
              )}
              <span className="text-muted-foreground text-xs">{t.comments.length}</span>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="flex flex-col gap-3 border-t px-3 py-3">
              {t.comments.map((c) => (
                <CommentView key={c.id} c={c} dir={dir} pending={isPending(c)} />
              ))}
              <div className="flex gap-2">
                <ReplyBox dir={dir} threadId={t.id} />
                {!allPending && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      await prReview(dir, { kind: 'resolve', threadId: t.id, resolved: !t.isResolved });
                      setBusy(false);
                    }}
                  >
                    {t.isResolved ? 'Unresolve' : 'Resolve'}
                  </Button>
                )}
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </Sized>
  );
}

/** A finding drawn in the diff; wraps FindingCard with the zone's size observer. */
function FindingZone({ f, dir, head, onSize }: { f: PrFinding; dir: string; head: string; onSize: () => void }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const ro = new ResizeObserver(onSize);
    ro.observe(el.current);
    return () => ro.disconnect();
  }, [onSize]);
  return (
    <div ref={el}>
      <FindingCard f={f} dir={dir} outdated={isOutdated(f, head)} onSize={onSize} />
    </div>
  );
}

/** Draw the snapshot's threads and the agent's open findings on `rel` in the diff editor; returns the cleanup. */
export function showPrThreads(diff: Monaco.editor.IStandaloneDiffEditor, root: string, rel: string): () => void {
  let dead = false;
  let clear = () => {};
  let snap: PrSnapshot | null = null;
  let findings: PrFinding[] = [];
  let composer: { side: 'LEFT' | 'RIGHT'; start: number; end: number } | null = null;
  let composerState: ComposerState = { body: '', suggest: false, suggestion: '' };
  const zoneFor = (
    ed: Monaco.editor.ICodeEditor,
    wantLine: number,
    node: (fit: () => void) => React.ReactNode,
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
    if (dead || !snap) return;
    const undo: (() => void)[] = [];
    for (const t of snap.threads.filter((x) => x.path === rel && x.comments.length)) {
      const left = t.side === 'LEFT' && !t.isOutdated;
      const ed = left ? diff.getOriginalEditor() : diff.getModifiedEditor();
      zoneFor(
        ed,
        t.line ?? t.originalLine ?? 1,
        (fit) => <ThreadCard t={t} dir={root} pendingId={snap?.pendingReview?.id} onSize={fit} />,
        undo,
      );
    }
    const head = snap.headSha;
    for (const f of findings.filter((x) => x.path === rel && x.status === 'open')) {
      const ed = f.side === 'LEFT' ? diff.getOriginalEditor() : diff.getModifiedEditor();
      zoneFor(ed, f.line, (fit) => <FindingZone f={f} dir={root} head={head} onSize={fit} />, undo);
    }
    if (composer) {
      const c = composer;
      const ed = c.side === 'LEFT' ? diff.getOriginalEditor() : diff.getModifiedEditor();
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
            dir={root}
            path={rel}
            side={c.side}
            startLine={c.start}
            line={c.end}
            oldText={oldText}
            state={composerState}
            onState={(st) => {
              composerState = st;
            }}
            onCancel={() => {
              composer = null;
              draw();
            }}
            onDone={() => {
              composer = null;
              composerState = { body: '', suggest: false, suggestion: '' };
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
  const gutter = (ed: Monaco.editor.ICodeEditor, side: 'LEFT' | 'RIGHT') => {
    let down: number | null = null;
    const GUTTER_LINE_NUMBERS = 3; // monaco.editor.MouseTargetType
    const d1 = ed.onMouseDown((e) => {
      down = e.target.type === GUTTER_LINE_NUMBERS && e.target.position ? e.target.position.lineNumber : null;
    });
    const d2 = ed.onMouseUp((e) => {
      if (down == null || !snap) return;
      const a = down;
      down = null;
      const b = e.target.position?.lineNumber ?? a;
      const start = Math.min(a, b);
      const end = Math.max(a, b);
      if (!composer || composer.side !== side || composer.start !== start || composer.end !== end)
        composerState = { body: '', suggest: false, suggestion: '' };
      composer = { side, start, end };
      draw();
    });
    return () => {
      d1.dispose();
      d2.dispose();
    };
  };
  const offGutter = [gutter(diff.getOriginalEditor(), 'LEFT'), gutter(diff.getModifiedEditor(), 'RIGHT')];
  const unreg = registerPrDiff(root, rel, diff);
  H.prFetch(root)
    .then((s) => {
      snap = s;
      draw();
    })
    .catch(() => {});
  const loadFindings = () =>
    H.prFindings(root)
      .then((l) => {
        findings = l;
        draw();
      })
      .catch(() => {});
  loadFindings();
  const offFindings = H.onPrFindings((p) => p === root && loadFindings());
  const offSnap = onPrSnapshot((r, s) => {
    if (r !== root) return;
    snap = s;
    draw();
  });
  return () => {
    dead = true;
    offSnap();
    for (const o of offGutter) o();
    offFindings();
    unreg();
    clear();
  };
}
