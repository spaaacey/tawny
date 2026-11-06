import { GitPullRequestIcon } from 'lucide-react';
import { Badge } from '@/ui/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/ui/empty';
import { useStore } from '../../store';

/** The PR tab. Phase 1 placeholder (title, number, state); the description/timeline come later. `k` is the tab key `p:<owner>/<repo>#<n>`. */
export function PrPane({ k, hidden }: { k: string | null; hidden: boolean }) {
  const pr = useStore((s) =>
    k
      ? s.app.repos.flatMap((r) => r.worktrees).find((w) => w.pr && `p:${w.pr.owner}/${w.pr.repo}#${w.pr.number}` === k)
          ?.pr
      : undefined,
  );
  if (hidden) return null;
  return (
    <Empty className="absolute inset-0 bg-[var(--term)]">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GitPullRequestIcon />
        </EmptyMedia>
        <EmptyTitle>{pr ? pr.title : k}</EmptyTitle>
        <EmptyDescription>{pr ? `${pr.owner}/${pr.repo} #${pr.number}` : 'Pull request'}</EmptyDescription>
        {pr && <Badge variant="outline">{pr.state}</Badge>}
      </EmptyHeader>
    </Empty>
  );
}
