import { ExternalLinkIcon, RefreshCwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import type { PrSnapshot } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { sessionsFor } from '../../lib/selectors';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { refreshDiffs } from '../editor/host';
import { prSnapshotChanged } from '../editor/prBus';
import { clearViewed } from '../tree/PrFilesView';
import { DoReview } from './PrFindings';
import { ago } from './prParts';

/** Shared actions for the PR pane toolbar and PR files sidebar. */
export function PrActions({ dir, snap, loading = false }: { dir: string; snap: PrSnapshot | null; loading?: boolean }) {
  const wt = useStore((s) => s.app.repos.flatMap((r) => r.worktrees).find((w) => w.path === dir));
  const chatId = useStore((s) => (wt ? sessionsFor(s.app, wt).find((x) => x.kind === 'chat')?.id : undefined));
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  const refresh = async () => {
    setBusy(true);
    try {
      const next = await H.prRefresh(dir);
      // A new head invalidates viewed marks and the git sides of open diffs.
      if (next.moved && next.moved.to !== snap?.moved?.to) clearViewed(dir, next.moved.latest);
      if (snap && snap.headSha !== next.headSha) void refreshDiffs(dir);
      prSnapshotChanged(dir, next);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className="rounded-full text-muted-foreground"
        asChild
        title={
          snap
            ? `Open on GitHub (refreshed ${ago(snap.fetchedAt)}, ${new Date(snap.fetchedAt).toLocaleString()})`
            : 'Open on GitHub'
        }
      >
        <a
          href={wt?.pr?.url}
          target="_blank"
          rel="noreferrer"
          aria-label={snap ? `Open on GitHub. Refreshed ${ago(snap.fetchedAt)}` : 'Open on GitHub'}
        >
          <ExternalLinkIcon />
        </a>
      </Button>
      <DoReview chatId={chatId} />
      <Button
        variant="ghost"
        size="xs"
        className="h-[20px] rounded-full text-muted-foreground"
        disabled={loading || busy}
        onClick={() => void refresh()}
      >
        {busy || loading ? <Spinner /> : <RefreshCwIcon />}
        Refresh
      </Button>
    </>
  );
}
