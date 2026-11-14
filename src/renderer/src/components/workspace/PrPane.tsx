import {
  CheckCircle2Icon,
  CheckIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  PencilIcon,
  XCircleIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from '@/ui/empty';
import { Input } from '@/ui/input';
import { Message, MessageContent, MessageHeader } from '@/ui/message';
import { ScrollArea } from '@/ui/scroll-area';
import { Separator } from '@/ui/separator';
import { Spinner } from '@/ui/spinner';
import type { PrEdit, PrMoved, PrReviewComment, PrReviewState, PrSnapshot } from '../../../../shared/types';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { openDiff, openFile } from '../editor/api';
import { onPrSnapshot, prSnapshotChanged } from '../editor/prBus';
import { CommentView, ThreadCard } from './PrDrafts';
import { FindingsSection } from './PrFindings';
import { GeneralDrafts, SubmitReview } from './PrSubmit';
import { Avatar, ago, Md } from './prParts';
import { RichMd } from './RichMd';

const REVIEW_BADGE: Partial<
  Record<PrReviewState, { label: string; variant: 'secondary' | 'outline' | 'destructive'; icon?: 'ok' | 'x' }>
> = {
  APPROVED: { label: 'Approved', variant: 'secondary', icon: 'ok' },
  CHANGES_REQUESTED: { label: 'Changes requested', variant: 'destructive', icon: 'x' },
  COMMENTED: { label: 'Commented', variant: 'outline' },
  DISMISSED: { label: 'Dismissed', variant: 'outline' },
};

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

function MovedBanner({ dir, moved }: { dir: string; moved: PrMoved }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="gap-0 py-0">
        <CardContent className="flex items-center gap-3 px-4 py-3 text-sm">
          <GitCommitHorizontalIcon className="size-4 shrink-0" />
          <span className="flex-1">
            <b>
              {moved.count} new commit{moved.count === 1 ? '' : 's'}
            </b>{' '}
            since you last looked ({moved.from.slice(0, 7)}..{moved.to.slice(0, 7)}
            {moved.forced ? ', force-pushed' : ''}). The worktree is up to date.
          </span>
          <CollapsibleTrigger asChild>
            <Button variant="outline" size="sm">
              Changes since ({moved.files.length})
            </Button>
          </CollapsibleTrigger>
          <Button variant="ghost" size="sm" onClick={async () => prSnapshotChanged(dir, await H.prDismissMoved(dir))}>
            Dismiss
          </Button>
        </CardContent>
        <CollapsibleContent>
          <div className="flex flex-col gap-1 border-t px-4 py-2">
            {moved.files.map((f) => (
              <button
                key={f.path}
                type="button"
                className="flex cursor-pointer items-center gap-2 text-left font-mono text-xs hover:underline"
                onClick={() => openDiff('r', `${moved.from}:${dir}/${f.path}`, { pin: true })}
              >
                <span className="w-4 text-muted-foreground">{f.status}</span>
                {f.path}
                {moved.latest.includes(f.path) && <Badge variant="outline">updated</Badge>}
              </button>
            ))}
            {!moved.files.length && <span className="text-muted-foreground text-xs">No file changes.</span>}
          </div>
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
  const [err, setErr] = useState('');
  const [, tick] = useState(0);
  const [draft, setDraft] = useState<PrEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState('');

  const load = useCallback(async () => {
    if (!dir) return;
    setErr('');
    try {
      const s = await H.prFetch(dir);
      setSnap(s);
      prSnapshotChanged(dir, s);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, [dir]);
  useEffect(() => {
    setSnap(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!dir) return;
    return onPrSnapshot((r, s) => r === dir && setSnap(s));
  }, [dir]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);

  const save = async () => {
    if (!dir || !draft) return;
    setSaving(true);
    setSaveErr('');
    try {
      const s = await H.prEdit(dir, draft);
      setSnap(s);
      prSnapshotChanged(dir, s);
      setDraft(null);
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => {
    if (!saving) {
      setDraft(null);
      setSaveErr('');
    }
  };
  const editKeys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') cancel();
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void save();
  };

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
  const pending = snap?.pendingReview;
  // Drafts live in the Pending review tray only; hide them (and draft-only threads) here.
  const visibleThreads = (snap?.threads ?? [])
    .map((t) => (pending ? { ...t, comments: t.comments.filter((c) => c.reviewId !== pending.id) } : t))
    .filter((t) => t.comments.length > 0);
  return (
    <div className="absolute inset-0 flex flex-col bg-[var(--term)]">
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-6 py-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-start gap-3">
              {draft ? (
                <Input
                  aria-label="Pull request title"
                  className="h-auto flex-1 py-1 font-semibold text-xl"
                  value={draft.title}
                  autoFocus
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  onKeyDown={editKeys}
                />
              ) : (
                <h1 className="flex-1 text-xl font-semibold leading-tight">
                  {snap?.title ?? pr.title} <span className="text-muted-foreground font-normal">#{pr.number}</span>
                </h1>
              )}
              {snap && snap.author?.login === snap.viewer && !draft && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setDraft({ title: snap.title, body: snap.body, base: snap.baseRef })}
                >
                  <PencilIcon />
                  Edit
                </Button>
              )}
              {draft && (
                <div className="flex gap-2">
                  <Button size="sm" variant="ghost" disabled={saving} onClick={cancel}>
                    Cancel
                  </Button>
                  <Button size="sm" disabled={saving || !draft.title.trim() || !draft.base.trim()} onClick={save}>
                    {saving ? <Spinner /> : <CheckIcon />}
                    Save
                  </Button>
                </div>
              )}
            </div>
            {(err || saveErr) && <span className="text-destructive text-xs">{saveErr || err}</span>}
          </div>

          {!snap ? (
            !err && (
              <div className="flex justify-center py-10">
                <Spinner />
              </div>
            )
          ) : (
            <>
              {snap.syncWarn && (
                <Card className="border-amber-500/60 py-3">
                  <CardContent className="px-4 text-sm">{snap.syncWarn}</CardContent>
                </Card>
              )}
              {snap.moved && <MovedBanner dir={dir} moved={snap.moved} />}
              <Card className="gap-0 py-0">
                <CardHeader className="border-b px-4 pb-2! pt-2">
                  <CardTitle className="font-normal text-xs">
                    <b>{snap.author?.login}</b>{' '}
                    <span className="text-muted-foreground">opened {ago(snap.createdAt)}</span>
                    {draft ? (
                      <span className="ml-2 inline-flex items-center gap-1.5 align-middle text-muted-foreground">
                        {snap.headRef} →
                        <Input
                          aria-label="Base branch"
                          className="h-6 w-48 px-2 py-0 text-xs"
                          value={draft.base}
                          onChange={(e) => setDraft({ ...draft, base: e.target.value })}
                          onKeyDown={editKeys}
                        />
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        {' · '}
                        {snap.headRef} → {snap.baseRef}
                      </span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 py-3">
                  {draft ? (
                    // biome-ignore lint/a11y/noStaticElementInteractions: Escape / cmd+enter bubble up from the editor
                    <div data-compose-card onKeyDown={editKeys}>
                      <RichMd
                        label="Pull request description"
                        value={draft.body}
                        onChange={(body) => setDraft((d) => d && { ...d, body })}
                      />
                    </div>
                  ) : (
                    <Md text={snap.body} />
                  )}
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

              <FindingsSection dir={dir} headSha={snap.headSha} />

              {visibleThreads.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                    Review threads ({visibleThreads.length})
                  </h2>
                  {visibleThreads.map((t) => (
                    <ThreadCard
                      key={t.id}
                      t={t}
                      dir={dir}
                      loc={{
                        text: `${t.path}${(t.line ?? t.originalLine) ? `:${t.line ?? t.originalLine}` : ''}`,
                        onClick: () =>
                          openFile(`${dir}/${t.path}`, {
                            pin: true,
                            selection:
                              (t.line ?? t.originalLine)
                                ? { lineNumber: (t.line ?? t.originalLine) as number, column: 1 }
                                : undefined,
                          }),
                      }}
                    />
                  ))}
                </section>
              )}

              <Separator />
              <section className="flex flex-col gap-2 pb-4">
                <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Pending review{pending ? ` (${pending.comments.length})` : ''}
                </h2>
                {pending?.comments.length ? (
                  pending.comments.map((c) => (
                    <Card key={c.id} className="gap-0 py-0">
                      <CardHeader className="justify-items-start px-3 py-1.5">
                        <Loc c={c} dir={dir} line={c.line} />
                      </CardHeader>
                      <CardContent className="border-t px-3 py-3">
                        <CommentView c={c} dir={dir} pending />
                      </CardContent>
                    </Card>
                  ))
                ) : (
                  <Card className="py-3">
                    <CardContent className="px-4 text-muted-foreground text-sm">
                      No pending comments. Click a line number in a PR file diff to add one, or Add to review on an
                      agent finding.
                    </CardContent>
                  </Card>
                )}
                <GeneralDrafts dir={dir} />
                <div className="flex justify-end">
                  <SubmitReview dir={dir} drafts={pending?.comments.length ?? 0} />
                </div>
              </section>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
