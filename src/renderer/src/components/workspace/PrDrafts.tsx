// Pending-review drafts of a PR session: a draft comment with edit/delete and a reply box (the gutter composer is review/Composer).
// Used by the diff view zones (editor/prThreads.tsx) and the PR tab.
import type { Editor } from '@tiptap/core';
import { MessageSquareIcon, PencilIcon, Trash2Icon } from 'lucide-react';
import { useRef, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Message, MessageContent, MessageHeader } from '@/ui/message';
import { Textarea } from '@/ui/textarea';
import type { PrReviewAction, PrReviewComment, PrThread } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { prSnapshotChanged } from '../editor/prBus';
import { CardTitle, ComposeCard, TargetChip } from '../review/ComposeCard';
import { Avatar, ago, Md } from './prParts';

/** Apply `action` to the GitHub pending review of PR worktree `dir`; on success every PR view redraws from the new snapshot. Resolves false (after a toast) on failure. */
export async function prReview(dir: string, action: PrReviewAction): Promise<boolean> {
  try {
    prSnapshotChanged(dir, await H.prReview(dir, action));
    return true;
  } catch (e) {
    toast((e as Error).message);
    return false;
  }
}

/** One comment; when it's part of the viewer's pending review it shows a Pending badge with Edit / Delete. */
export function CommentView({ c, dir, pending }: { c: PrReviewComment; dir: string; pending: boolean }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const [busy, setBusy] = useState(false);
  const run = async (a: PrReviewAction) => {
    setBusy(true);
    const ok = await prReview(dir, a);
    setBusy(false);
    return ok;
  };
  return (
    <Message>
      <Avatar user={c.author} />
      <MessageContent>
        <MessageHeader className="gap-2 text-xs">
          <b>{c.author?.login}</b>
          <span className="text-muted-foreground">{ago(c.createdAt)}</span>
          {pending && <Badge variant="secondary">Pending</Badge>}
          <span className="flex-1" />
          {pending && !editing && (
            <>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Edit"
                onClick={() => {
                  setBody(c.body);
                  setEditing(true);
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                title="Delete from review"
                disabled={busy}
                onClick={() => run({ kind: 'delete', commentId: c.id })}
              >
                <Trash2Icon />
              </Button>
            </>
          )}
        </MessageHeader>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} />
            <div className="flex gap-2">
              <Button
                size="xs"
                disabled={busy || !body.trim()}
                onClick={async () => (await run({ kind: 'edit', commentId: c.id, body })) && setEditing(false)}
              >
                Save
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Md text={c.body} />
        )}
      </MessageContent>
    </Message>
  );
}

/** Reply to an existing thread: a compose card (markdown, cmd+enter, esc closes); the reply goes into the pending review. */
export function ReplyComposer({
  dir,
  threadId,
  author,
  onClose,
}: {
  dir: string;
  threadId: string;
  author?: string;
  onClose: () => void;
}) {
  const edRef = useRef<Editor | null>(null);
  const body = useRef('');
  const [canSubmit, setCanSubmit] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <ComposeCard
      className="compose-flow"
      editorRef={edRef}
      title={<CardTitle icon={<MessageSquareIcon />} title={`Reply to ${author ?? 'thread'}`} />}
      onClose={onClose}
      closeTitle="Discard (esc)"
      initial=""
      onChange={(md) => {
        body.current = md;
        setCanSubmit(!!md.trim());
      }}
      placeholder={() => 'Reply (added to your pending review)…'}
      autoFocus
      tools={<TargetChip>Pending review</TargetChip>}
      submitLabel="Reply"
      canSubmit={canSubmit && !busy}
      onSubmit={async () => {
        setBusy(true);
        const ok = await prReview(dir, { kind: 'reply', threadId, body: body.current });
        setBusy(false);
        if (ok) onClose();
      }}
      onDiscard={onClose}
    />
  );
}

/** A review thread in read mode of the shared card: chevron header (Thread, location, badges, comment count), the comments stacked, footer Resolve/Unresolve left and Reply right (opens a ReplyComposer below). `loc` in the PR tab; in a diff the line is implicit. */
export function ThreadCard({
  t,
  dir,
  pendingId,
  loc,
  onSize,
}: {
  t: PrThread;
  dir: string;
  pendingId?: string;
  loc?: { text: string; onClick: () => void };
  onSize?: () => void;
}) {
  const [open, setOpen] = useState(!t.isResolved);
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const isPending = (c: PrThread['comments'][number]) => !!pendingId && c.reviewId === pendingId;
  const hasPending = t.comments.some(isPending);
  const allPending = t.comments.every(isPending);
  const first = t.comments[0];
  const resize = () => requestAnimationFrame(() => onSize?.());
  return (
    <div className="flex flex-col gap-2">
      <ComposeCard
        className="compose-flow"
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          resize();
        }}
        summary={first ? `${first.author?.login ?? ''}: ${first.body.split('\n')[0]}` : ''}
        title={
          <CardTitle
            icon={<MessageSquareIcon />}
            title="Thread"
            loc={loc?.text}
            onLoc={loc?.onClick}
            badges={
              <>
                {hasPending && <Badge variant="secondary">Pending</Badge>}
                {t.isResolved && <Badge variant="secondary">Resolved</Badge>}
                {t.isOutdated && (
                  <Badge variant="outline" title="The code changed since this comment; shown at its original line">
                    Outdated
                  </Badge>
                )}
              </>
            }
          />
        }
        count={t.comments.length}
        body={
          <div className="flex flex-col gap-3">
            {t.comments.map((c) => (
              <CommentView key={c.id} c={c} dir={dir} pending={isPending(c)} />
            ))}
          </div>
        }
        footer={
          <>
            {!allPending && (
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground"
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
            {!replying && (
              <Button
                size="xs"
                className="ml-auto"
                onClick={() => {
                  setReplying(true);
                  resize();
                }}
              >
                Reply
              </Button>
            )}
          </>
        }
      />
      {replying && (
        <ReplyComposer
          dir={dir}
          threadId={t.id}
          author={first?.author?.login}
          onClose={() => {
            setReplying(false);
            resize();
          }}
        />
      )}
    </div>
  );
}
