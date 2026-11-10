// Pending-review drafts of a PR session: a draft comment with edit/delete and a reply box (the gutter composer is review/Composer).
// Used by the diff view zones (editor/prThreads.tsx) and the PR tab.
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Message, MessageContent, MessageHeader } from '@/ui/message';
import { Textarea } from '@/ui/textarea';
import type { PrReviewAction, PrReviewComment } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { prSnapshotChanged } from '../editor/prBus';
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

/** Reply to an existing thread; the reply goes into the pending review. */
export function ReplyBox({ dir, threadId }: { dir: string; threadId: string }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
        Reply
      </Button>
    );
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        rows={2}
        placeholder="Reply (added to your pending review)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="xs"
          disabled={busy || !body.trim()}
          onClick={async () => {
            setBusy(true);
            const ok = await prReview(dir, { kind: 'reply', threadId, body });
            setBusy(false);
            if (ok) {
              setBody('');
              setOpen(false);
            }
          }}
        >
          Add to review
        </Button>
        <Button size="xs" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
