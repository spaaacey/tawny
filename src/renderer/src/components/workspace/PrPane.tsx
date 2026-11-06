import {
  CheckCircle2Icon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  RefreshCwIcon,
  XCircleIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/ui/empty';
import { Message, MessageAvatar, MessageContent, MessageHeader } from '@/ui/message';
import { ScrollArea } from '@/ui/scroll-area';
import { Separator } from '@/ui/separator';
import { Spinner } from '@/ui/spinner';
import type { PrReviewComment, PrReviewState, PrSnapshot, PrThread, PrUser } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { openFile } from '../editor/api';

const ago = (t: string | number) => {
  const s = Math.round((Date.now() - new Date(t).getTime()) / 1000);
  const f = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (s < 45) return 'just now';
  if (s < 3600) return f.format(-Math.round(s / 60), 'minute');
  if (s < 86400) return f.format(-Math.round(s / 3600), 'hour');
  return f.format(-Math.round(s / 86400), 'day');
};

const STATE_BADGE: Record<PrSnapshot['state'], { label: string; cls: string }> = {
  OPEN: { label: 'Open', cls: 'bg-emerald-600 text-white' },
  MERGED: { label: 'Merged', cls: 'bg-purple-600 text-white' },
  CLOSED: { label: 'Closed', cls: 'bg-red-600 text-white' },
};
const REVIEW_BADGE: Partial<
  Record<PrReviewState, { label: string; variant: 'secondary' | 'outline' | 'destructive'; icon?: 'ok' | 'x' }>
> = {
  APPROVED: { label: 'Approved', variant: 'secondary', icon: 'ok' },
  CHANGES_REQUESTED: { label: 'Changes requested', variant: 'destructive', icon: 'x' },
  COMMENTED: { label: 'Commented', variant: 'outline' },
  DISMISSED: { label: 'Dismissed', variant: 'outline' },
};

function Md({ text }: { text: string }) {
  if (!text.trim()) return <div className="text-muted-foreground text-xs italic">No description provided.</div>;
  return (
    <div className="chat-md text-[13.5px]" dangerouslySetInnerHTML={{ __html: window.tawnyChatMd.render(text) }} />
  );
}

function Avatar({ user }: { user: PrUser | null }) {
  return (
    <MessageAvatar className="size-7 min-w-7 self-start">
      {user?.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="size-7" />
      ) : (
        <span className="text-xs">{(user?.login || '?')[0]}</span>
      )}
    </MessageAvatar>
  );
}

function Loc({ c, dir, line }: { c: Pick<PrReviewComment, 'path'>; dir: string; line: number | null }) {
  return (
    <button
      type="button"
      className="cursor-pointer font-mono text-xs underline-offset-2 hover:underline"
      onClick={() =>
        openFile(`${dir}/${c.path}`, { pin: true, selection: line ? { lineNumber: line, column: 1 } : undefined })
      }
    >
      {c.path}
      {line ? `:${line}` : ''}
    </button>
  );
}

function Thread({ t, dir }: { t: PrThread; dir: string }) {
  const [open, setOpen] = useState(!t.isResolved);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="gap-0 py-0">
        <CollapsibleTrigger asChild>
          <CardHeader className="flex cursor-pointer flex-row items-center gap-2 px-3 py-2">
            <ChevronRightIcon className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
            <Loc c={t} dir={dir} line={t.line ?? t.originalLine} />
            <span className="flex-1" />
            {t.isResolved && <Badge variant="secondary">Resolved</Badge>}
            {t.isOutdated && <Badge variant="outline">Outdated</Badge>}
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
  );
}

/** The PR tab: header, description, conversation, review threads and the (phase 5) pending review tray. `k` is the tab key `p:<owner>/<repo>#<n>`. */
export function PrPane({ k, hidden }: { k: string | null; hidden: boolean }) {
  const wt = useStore((s) =>
    k
      ? s.app.repos.flatMap((r) => r.worktrees).find((w) => w.pr && `p:${w.pr.owner}/${w.pr.repo}#${w.pr.number}` === k)
      : undefined,
  );
  const dir = wt?.path;
  const [snap, setSnap] = useState<PrSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);

  const load = useCallback(
    async (refresh: boolean) => {
      if (!dir) return;
      setBusy(true);
      setErr('');
      try {
        setSnap(await (refresh ? H.prRefresh(dir) : H.prFetch(dir)));
      } catch (e) {
        setErr((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [dir],
  );
  useEffect(() => {
    setSnap(null);
    void load(false);
  }, [load]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  if (hidden) return null;
  if (!wt?.pr || !dir)
    return (
      <Empty className="absolute inset-0 bg-[var(--term)]">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <GitPullRequestIcon />
          </EmptyMedia>
          <EmptyTitle>{k}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  const pr = wt.pr;
  const sb = snap && STATE_BADGE[snap.state];
  const pending = snap?.pendingReview;
  return (
    <div className="absolute inset-0 bg-[var(--term)]">
      <ScrollArea className="h-full">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-3">
              <h1 className="flex-1 text-xl font-semibold leading-tight">
                {snap?.title ?? pr.title} <span className="text-muted-foreground font-normal">#{pr.number}</span>
              </h1>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => load(true)}>
                {busy ? <Spinner /> : <RefreshCwIcon />}
                Refresh
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {sb && <Badge className={sb.cls}>{snap.isDraft && snap.state === 'OPEN' ? 'Draft' : sb.label}</Badge>}
              {snap?.reviewDecision === 'APPROVED' && <Badge variant="secondary">Approved</Badge>}
              {snap?.reviewDecision === 'CHANGES_REQUESTED' && <Badge variant="destructive">Changes requested</Badge>}
              {snap && (
                <span className="text-muted-foreground">
                  <b className="text-foreground">{snap.author?.login}</b> wants to merge{' '}
                  <code className="font-mono text-xs">{snap.headRef}</code> into{' '}
                  <code className="font-mono text-xs">{snap.baseRef}</code>
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 text-muted-foreground text-xs">
              <Button variant="link" size="xs" className="h-auto p-0 text-xs" asChild>
                <a href={pr.url} target="_blank" rel="noreferrer">
                  Open on GitHub <ExternalLinkIcon />
                </a>
              </Button>
              {snap && <span title={new Date(snap.fetchedAt).toLocaleString()}>Refreshed {ago(snap.fetchedAt)}</span>}
              {err && <span className="text-destructive">{err}</span>}
            </div>
          </div>

          {!snap ? (
            !err && (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            )
          ) : (
            <>
              <Card className="gap-0 py-0">
                <CardHeader className="border-b px-4 pb-2! pt-2">
                  <CardTitle className="font-normal text-xs">
                    <b>{snap.author?.login}</b>{' '}
                    <span className="text-muted-foreground">opened {ago(snap.createdAt)}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 py-3">
                  <Md text={snap.body} />
                </CardContent>
              </Card>

              <section className="flex flex-col gap-3">
                <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Conversation ({snap.timeline.length})
                </h2>
                {snap.timeline.map((it) => {
                  const rb = it.kind === 'review' ? REVIEW_BADGE[it.state] : undefined;
                  return (
                    <Message key={it.id}>
                      <Avatar user={it.author} />
                      <MessageContent>
                        <MessageHeader className="gap-2 text-xs">
                          <b>{it.author?.login}</b>
                          <span className="text-muted-foreground">
                            {it.kind === 'review' ? 'reviewed ' : 'commented '}
                            {ago(it.createdAt)}
                          </span>
                          {rb && (
                            <Badge variant={rb.variant}>
                              {rb.icon === 'ok' && <CheckCircle2Icon />}
                              {rb.icon === 'x' && <XCircleIcon />}
                              {rb.label}
                            </Badge>
                          )}
                          {it.kind === 'review' && it.threadCount > 0 && (
                            <span className="text-muted-foreground inline-flex items-center gap-1">
                              <MessageSquareIcon className="size-3" />
                              {it.threadCount}
                            </span>
                          )}
                        </MessageHeader>
                        {it.body.trim() && <Md text={it.body} />}
                      </MessageContent>
                    </Message>
                  );
                })}
              </section>

              {snap.threads.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Review threads ({snap.threads.length})
                  </h2>
                  {snap.threads.map((t) => (
                    <Thread key={t.id} t={t} dir={dir} />
                  ))}
                </section>
              )}

              <Separator />
              <section className="flex flex-col gap-2 pb-4">
                <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Pending review</h2>
                <Card className="py-3">
                  <CardContent className="px-4 text-muted-foreground text-sm">
                    {pending
                      ? `${pending.comments.length} pending comment${pending.comments.length === 1 ? '' : 's'} on GitHub. Editing and submitting arrive in a later phase.`
                      : 'No pending review. Drafting and submitting arrive in a later phase.'}
                  </CardContent>
                </Card>
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
