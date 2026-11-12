// PR review source for the shared view-zone host (review/zones.tsx): threads, pending drafts, agent findings and the comment composer in a PR file's diff ('d:r:' tabs), from the stored PrSnapshot.
import type * as Monaco from 'monaco-editor';
import type { PrFinding, PrSnapshot } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { Sized } from '../review/Composer';
import { type ReviewZoneSource, showReviewZones } from '../review/zones';
import { prReview, ThreadCard } from '../workspace/PrDrafts';
import { FindingComposer, isOutdated } from '../workspace/PrFindings';
import { onPrSnapshot, useHideComments } from './prBus';

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
      const offHide = useHideComments.subscribe((s, p) => s.hidden !== p.hidden && changed());
      const offSnap = onPrSnapshot((r, s) => {
        if (r !== root) return;
        snap = s;
        changed();
      });
      return () => {
        dead = true;
        offSnap();
        offFindings();
        offHide();
      };
    },
    threads: (rel) =>
      (useHideComments.getState().hidden ? [] : (snap?.threads ?? []))
        .filter((t) => t.path === rel && t.comments.length)
        .map((t) => ({
          key: t.id,
          side: t.side === 'LEFT' && !t.isOutdated ? 'LEFT' : 'RIGHT',
          line: t.line ?? t.originalLine ?? 1,
          render: (fit) => (
            <Sized onSize={fit}>
              <ThreadCard t={t} dir={root} pendingId={snap?.pendingReview?.id} onSize={fit} />
            </Sized>
          ),
        })),
    items: (rel) =>
      (useHideComments.getState().hidden ? [] : findings).filter((x) => x.path === rel && x.status === 'open'),
    renderItem: (f, fit) => (
      <Sized onSize={fit}>
        <FindingComposer f={f} dir={root} outdated={isOutdated(f, snap?.headSha ?? '')} onSize={fit} />
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
