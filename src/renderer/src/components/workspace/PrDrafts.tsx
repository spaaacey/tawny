// Pending-review drafts of a PR session: the composer (new thread on a line range), a draft comment with edit/delete,
// a reply box and the mini suggestion diff. Used by the diff view zones (editor/prThreads.tsx) and the PR tab's tray.
import { PencilIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import { Label } from '@/ui/label';
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

/** Calls `onSize` whenever its content resizes (view zones follow their React content). */
export function Sized({ onSize, children }: { onSize?: () => void; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !onSize) return;
    const ro = new ResizeObserver(onSize);
    ro.observe(el.current);
    return () => ro.disconnect();
  }, [onSize]);
  return <div ref={el}>{children}</div>;
}

/** Selected lines struck out above the replacement, as GitHub renders a suggestion. */
export function SuggestionDiff({ old, text }: { old: string; text: string }) {
  const rows = (t: string) => (t === '' ? [] : t.replace(/\n$/, '').split('\n'));
  return (
    <div className="overflow-x-auto rounded border font-mono text-xs leading-5">
      {rows(old).map((l, i) => (
        <div key={`o${i}`} className="whitespace-pre bg-red-500/10 px-2">
          <span className="select-none text-red-600">- </span>
          {l}
        </div>
      ))}
      {rows(text).map((l, i) => (
        <div key={`n${i}`} className="whitespace-pre bg-emerald-500/10 px-2">
          <span className="select-none text-emerald-600">+ </span>
          {l}
        </div>
      ))}
    </div>
  );
}

export interface ComposerState {
  body: string;
  suggest: boolean;
  suggestion: string;
}

/** New thread on `path` lines `startLine`..`line` of `side`; the draft goes into the GitHub pending review. Suggestions only on RIGHT. */
export function Composer({
  dir,
  path,
  side,
  startLine,
  line,
  oldText,
  state,
  onState,
  onCancel,
  onDone,
  onSize,
}: {
  dir: string;
  path: string;
  side: 'LEFT' | 'RIGHT';
  startLine: number;
  line: number;
  /** text of the selected lines (the suggestion's starting point) */
  oldText: string;
  state: ComposerState;
  onState: (s: ComposerState) => void;
  onCancel: () => void;
  onDone: () => void;
  onSize: () => void;
}) {
  const [busy, setBusy] = useState(false);
  // the owner keeps the draft (it survives zone redraws); `state` is only the initial value
  const [cur, setCur] = useState(state);
  const set = (p: Partial<ComposerState>) => {
    const next = { ...cur, ...p };
    setCur(next);
    onState(next);
  };
  const canSuggest = side === 'RIGHT';
  const suggest = canSuggest && cur.suggest;
  const submit = async () => {
    setBusy(true);
    const ok = await prReview(dir, {
      kind: 'thread',
      path,
      line,
      startLine: startLine < line ? startLine : undefined,
      side,
      body: cur.body,
      suggestion: suggest ? cur.suggestion : undefined,
    });
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <Sized onSize={onSize}>
      <Card className="gap-0 py-0">
        <CardHeader className="flex flex-row items-center gap-2 px-3 py-1.5">
          <span className="text-xs font-medium">
            Comment on {startLine < line ? `lines ${startLine}-${line}` : `line ${line}`}
          </span>
          <Badge variant="outline">{side === 'LEFT' ? 'Original' : 'Modified'}</Badge>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 border-t px-3 py-2">
          <Textarea
            autoFocus
            rows={3}
            placeholder="Leave a comment (kept in your pending review until you submit)"
            value={cur.body}
            onChange={(e) => {
              set({ body: e.target.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancel();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) void submit();
            }}
          />
          <div
            className="flex items-center gap-2"
            title={canSuggest ? undefined : 'Suggestions only work on the modified side'}
          >
            <Checkbox
              id="pr-suggest"
              disabled={!canSuggest}
              checked={suggest}
              onCheckedChange={(c) => set({ suggest: c === true, suggestion: cur.suggestion || oldText })}
            />
            <Label htmlFor="pr-suggest" className={canSuggest ? '' : 'opacity-50'}>
              Suggest a change
            </Label>
          </div>
          {suggest && (
            <>
              <Textarea
                rows={Math.max(2, cur.suggestion.split('\n').length)}
                className="font-mono text-xs"
                value={cur.suggestion}
                onChange={(e) => set({ suggestion: e.target.value })}
              />
              <SuggestionDiff old={oldText} text={cur.suggestion} />
            </>
          )}
          <div className="flex gap-2">
            <Button size="xs" disabled={busy || (!cur.body.trim() && !suggest)} onClick={submit}>
              Add to review
            </Button>
            <Button size="xs" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </CardContent>
      </Card>
    </Sized>
  );
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
