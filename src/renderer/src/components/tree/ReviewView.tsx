// Review rail view: review your own branch (docs/local-review-plan.md). Header (base + Review) and the branch's changed
// files with a per-file count of live comments; items are read, edited and sent to an agent on the diff cards.
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { ScrollArea } from '@/ui/scroll-area';
import type { LocalReviewFiles } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { openBranchDiff } from '../editor/branchDiff';
import { type ChangedFile, ChangedFilesList, DIM } from '../review/ChangedFilesList';
import { useLocalReview } from '../review/localStore';
import { createViewedStore } from '../review/viewed';
import { activeKey } from '../workspace/layoutStore';
import { DoReview } from '../workspace/PrFindings';
import { useTree } from './store';

/** worktree path -> viewed file paths */
const viewedStore = createViewedStore('localReviewViewed');

const fail = (e: unknown) => toast((e as Error).message);

export function ReviewView() {
  const dir = useTree((s) => s.root);
  if (!dir) return null;
  return <Body key={dir} dir={dir} />;
}

function Body({ dir }: { dir: string }) {
  const state = useLocalReview(dir);
  const [files, setFiles] = useState<LocalReviewFiles | null>(null);
  const [err, setErr] = useState('');
  const tick = useTree((s) => s.tick);
  const base = state?.base;
  const mb = state?.mergeBase;
  // refetch files when the base, the items or the working tree change
  useEffect(() => {
    let live = true;
    H.lrFiles(dir).then(
      (f) => {
        if (!live) return;
        setFiles(f);
        setErr('');
      },
      (e) => live && setErr((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [dir, tick, base, mb]);

  const items = state?.items ?? [];
  // live comments per file (open or sent)
  const counts = new Map<string, number>();
  for (const it of items)
    if (it.status === 'open' || it.status === 'sent') counts.set(it.path, (counts.get(it.path) ?? 0) + 1);
  const resolved = items.filter((i) => i.status === 'fixed' || i.status === 'dismissed').length;
  // files with live comments that are no longer in the diff (e.g. reverted) stay listed so comments aren't lost
  const changed = files?.files ?? [];
  const known = new Set(changed.map((f) => f.path));
  const extra: ChangedFile[] = files
    ? [...counts.keys()].filter((p) => !known.has(p)).map((path) => ({ path, status: '?' }))
    : [];

  return (
    <>
      <div className="flex items-center gap-2 border-b px-2 py-1.5" role="toolbar" aria-label="Local review">
        <span className={`min-w-0 flex-1 truncate text-xs ${DIM}`} title={state?.mergeBase ?? undefined}>
          {state ? (
            <>
              vs <span className="font-mono">{state.base}</span>
              {state.mergeBase && <span className="font-mono"> @ {state.mergeBase.slice(0, 7)}</span>}
            </>
          ) : (
            'Loading…'
          )}
        </span>
        {state && <DoReview local={{ dir, base: state.base }} />}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {err ? (
          <div className="tree-empty">{err}</div>
        ) : (
          <ChangedFilesList
            files={[...changed, ...extra]}
            viewedId={dir}
            viewedStore={viewedStore}
            title="Branch changes"
            emptyText={files ? 'No changes against the base' : 'Loading…'}
            onOpen={(f, pin) => openBranchDiff(dir, `${dir}/${f.path}`, { pin }).catch(fail)}
            isActive={(f) => activeKey() === `d:b:${dir}/${f.path}`}
            count={(p) => counts.get(p) ?? 0}
            countTitle={(n) => `${n} open comment${n > 1 ? 's' : ''}`}
          />
        )}
      </ScrollArea>
      {resolved > 0 && (
        <div className="flex border-t px-2 py-1">
          <Button
            variant="ghost"
            size="xs"
            title="Remove fixed and dismissed comments"
            onClick={() => H.lrClearResolved(dir).catch(fail)}
          >
            Clear resolved ({resolved})
          </Button>
        </div>
      )}
    </>
  );
}
