// Read-only PR review threads drawn as view zones in a PR file's diff ('d:r:' tabs), from the stored PrSnapshot.
import { ChevronRightIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Badge } from '@/ui/badge';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Message, MessageContent, MessageHeader } from '@/ui/message';
import type { PrFinding, PrSnapshot, PrThread } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { FindingCard, isOutdated } from '../workspace/PrFindings';
import { Avatar, ago, Md } from '../workspace/prParts';
import { registerPrDiff } from './prReveal';

type Listener = (root: string, snap: PrSnapshot) => void;
const listeners = new Set<Listener>();
export const onPrSnapshot = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** The PR tab fetched / refreshed `root`'s snapshot: open PR diffs redraw their threads. */
export const prSnapshotChanged: Listener = (root, snap) => {
  for (const l of listeners) l(root, snap);
};

function ThreadCard({ t, onSize }: { t: PrThread; onSize: () => void }) {
  const [open, setOpen] = useState(!t.isResolved);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const ro = new ResizeObserver(onSize);
    ro.observe(el.current);
    return () => ro.disconnect();
  }, [onSize]);
  return (
    <div ref={el}>
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
                <Message key={c.id}>
                  <Avatar user={c.author} />
                  <MessageContent>
                    <MessageHeader className="gap-2 text-xs">
                      <b>{c.author?.login}</b>
                      <span className="text-muted-foreground">{ago(c.createdAt)}</span>
                    </MessageHeader>
                    <Md text={c.body} />
                  </MessageContent>
                </Message>
              ))}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
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
      suppressMouseDown: true,
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
      zoneFor(ed, t.line ?? t.originalLine ?? 1, (fit) => <ThreadCard t={t} onSize={fit} />, undo);
    }
    const head = snap.headSha;
    for (const f of findings.filter((x) => x.path === rel && x.status !== 'dismissed')) {
      const ed = f.side === 'LEFT' ? diff.getOriginalEditor() : diff.getModifiedEditor();
      zoneFor(ed, f.line, (fit) => <FindingZone f={f} dir={root} head={head} onSize={fit} />, undo);
    }
    clear = () => {
      for (const u of undo) u();
      clear = () => {};
    };
  };
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
  const l: Listener = (r, s) => {
    if (r !== root) return;
    snap = s;
    draw();
  };
  listeners.add(l);
  return () => {
    dead = true;
    listeners.delete(l);
    offFindings();
    unreg();
    clear();
  };
}
