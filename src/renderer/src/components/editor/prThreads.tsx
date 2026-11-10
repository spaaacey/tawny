// PR review source for the shared view-zone host (review/zones.tsx): threads, pending drafts, agent findings and the comment composer in a PR file's diff ('d:r:' tabs), from the stored PrSnapshot.
import { ChevronRightIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import type { PrFinding, PrSnapshot, PrThread } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { Sized } from '../review/Composer';
import { type ReviewZoneSource, showReviewZones } from '../review/zones';
import { CommentView, prReview, ReplyBox } from '../workspace/PrDrafts';
import { FindingCard, isOutdated } from '../workspace/PrFindings';
import { onPrSnapshot } from './prBus';

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

/** The PR review source for `showReviewZones`: snapshot threads, open findings and a composer that drafts into the GitHub pending review. */
function prZoneSource(root: string): ReviewZoneSource<PrFinding> {
  let snap: PrSnapshot | null = null;
  let findings: PrFinding[] = [];
  return {
    kind: 'pr',
    ready: () => !!snap,
    subscribe: (changed) => {
      let dead = false;
      H.prFetch(root)
        .then((s) => {
          if (dead) return;
          snap = s;
          changed();
        })
        .catch(() => {});
      const loadFindings = () =>
        H.prFindings(root)
          .then((l) => {
            if (dead) return;
            findings = l;
            changed();
          })
          .catch(() => {});
      loadFindings();
      const offFindings = H.onPrFindings((p) => p === root && loadFindings());
      const offSnap = onPrSnapshot((r, s) => {
        if (r !== root) return;
        snap = s;
        changed();
      });
      return () => {
        dead = true;
        offSnap();
        offFindings();
      };
    },
    threads: (rel) =>
      (snap?.threads ?? [])
        .filter((t) => t.path === rel && t.comments.length)
        .map((t) => ({
          key: t.id,
          side: t.side === 'LEFT' && !t.isOutdated ? 'LEFT' : 'RIGHT',
          line: t.line ?? t.originalLine ?? 1,
          render: (fit) => <ThreadCard t={t} dir={root} pendingId={snap?.pendingReview?.id} onSize={fit} />,
        })),
    items: (rel) => findings.filter((x) => x.path === rel && x.status === 'open'),
    renderItem: (f, fit) => (
      <Sized onSize={fit}>
        <FindingCard f={f} dir={root} outdated={isOutdated(f, snap?.headSha ?? '')} onSize={fit} />
      </Sized>
    ),
    composer: {
      sides: ['LEFT', 'RIGHT'],
      placeholder: 'Leave a comment (kept in your pending review until you submit)',
      submit: (c) => prReview(root, { kind: 'thread', ...c }),
    },
  };
}

/** Draw the snapshot's threads and the agent's open findings on `rel` in the diff editor; returns the cleanup. */
export function showPrThreads(diff: Monaco.editor.IStandaloneDiffEditor, root: string, rel: string): () => void {
  return showReviewZones(diff, root, rel, prZoneSource(root));
}
