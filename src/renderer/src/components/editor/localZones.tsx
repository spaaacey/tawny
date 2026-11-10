// Local review source for the shared view-zone host (review/zones.tsx), for branch diffs ('d:b:' tabs):
// an item card per non-dismissed item of the file, a RIGHT-side gutter composer for your own comments, and live drift:
// Monaco decorations follow each item's lines while you edit, and the moved lines are persisted when the file is saved.
import { UserIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { Button } from '@/ui/button';
import { ButtonGroup } from '@/ui/button-group';
import type { ReviewItem } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { saveListeners } from '../../lsp/models';
import { Sized } from '../review/Composer';
import { type ItemBadge, ItemCard } from '../review/ItemCard';
import { loadLocalReview, localReviewOf, subscribeLocalReview } from '../review/localStore';
import { FixChatPicker, sendToFixChat, useFixChats } from '../review/sendToFixChat';
import { type ReviewZoneSource, showReviewZones } from '../review/zones';

const act = (p: Promise<unknown>) => p.catch((e: Error) => toast(e.message));

function LocalItemCard({ item, root, onSize }: { item: ReviewItem; root: string; onSize: () => void }) {
  const badges: ItemBadge[] = [];
  if (item.status === 'sent') badges.push({ label: 'Sent', title: 'Sent to an agent to fix' });
  if (item.status === 'fixed') badges.push({ label: 'Fixed', title: 'An agent marked this fixed' });
  if (item.outdated)
    badges.push({
      label: 'Outdated',
      variant: 'outline',
      title: 'The code changed and this comment no longer matches; shown at its last known line',
    });
  const setStatus = (status: ReviewItem['status']) => act(H.lrSetStatus(root, item.id, status));
  const { chats, target, setPicked } = useFixChats(root);
  return (
    <ItemCard
      item={item}
      onSize={onSize}
      badges={badges}
      icon={item.source === 'user' ? <UserIcon className="size-3.5 text-muted-foreground" /> : undefined}
      label={item.source === 'user' ? 'Your comment' : 'Agent finding'}
      canSuggest
      actions={({ editing, draft, toggleEdit }) => (
        <>
          {editing && (
            <Button
              size="xs"
              disabled={!draft.body.trim()}
              onClick={async () => {
                await act(H.lrEditItem(root, item.id, { body: draft.body, detail: '', suggestion: draft.suggestion }));
                toggleEdit();
              }}
            >
              Save
            </Button>
          )}
          <Button size="xs" variant="outline" onClick={toggleEdit}>
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          {(item.status === 'open' || item.status === 'sent') && (
            <ButtonGroup>
              <Button
                size="xs"
                disabled={!target}
                title="Put the fix prompt in the chat's composer (not sent)"
                onClick={() => act(sendToFixChat(root, [item], target?.id))}
              >
                {item.status === 'sent' ? 'Resend to agent' : 'Send to agent'}
              </Button>
              <FixChatPicker chats={chats} target={target} onPick={setPicked} className="max-w-32" />
            </ButtonGroup>
          )}
          {(item.status === 'sent' || item.status === 'fixed') && (
            <Button size="xs" variant="ghost" onClick={() => setStatus('open')}>
              Reopen
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={() => setStatus('dismissed')}>
            Dismiss
          </Button>
        </>
      )}
    >
      {item.status === 'fixed' && item.note && <p className="text-xs">Fixed: {item.note}</p>}
    </ItemCard>
  );
}

interface Tracked {
  deco: string;
  /** the lines the server last had (what a save persists against) */
  start: number;
  end: number;
  /** the range was empty when created (a blank line), so an empty range doesn't mean deleted */
  blank: boolean;
}

/** Draw the local review's items and composer on `rel` in the branch diff editor; returns the cleanup. */
export function showLocalZones(
  diff: Monaco.editor.IStandaloneDiffEditor,
  root: string,
  rel: string,
  abs: string,
): () => void {
  const model = diff.getModifiedEditor().getModel();
  const tracked = new Map<string, Tracked>();
  let signature = '';
  const persisted = new Map<string, string>();

  const visible = () => (localReviewOf(root)?.items ?? []).filter((i) => i.path === rel && i.status !== 'dismissed');
  const clampLine = (n: number) => Math.min(Math.max(1, n), model?.getLineCount() ?? n);
  const rangeOf = (start: number, end: number) => {
    const s = clampLine(start);
    const e = clampLine(end);
    return { startLineNumber: s, startColumn: 1, endLineNumber: e, endColumn: model?.getLineMaxColumn(e) ?? 1 };
  };
  const decoOpts = { stickiness: 1 /* NeverGrowsWhenTypingAtEdges */ };
  /** Live lines of a tracked item, or null when its text was deleted (the range collapsed). */
  const live = (t: Tracked) => {
    const r = model?.getDecorationRange(t.deco);
    if (!r) return null;
    return { start: r.startLineNumber, end: r.endLineNumber, gone: !t.blank && r.isEmpty() };
  };

  /** Make the decorations match the store: add new items, reset those the server moved, drop gone ones. */
  const sync = () => {
    if (!model) return;
    const items = visible();
    const ids = new Set(items.map((i) => i.id));
    for (const [id, t] of tracked)
      if (!ids.has(id)) {
        model.deltaDecorations([t.deco], []);
        tracked.delete(id);
      }
    for (const i of items) {
      const start = i.startLine ?? i.line;
      const t = tracked.get(i.id);
      if (t && t.start === start && t.end === i.line) continue;
      const range = rangeOf(start, i.line);
      const [deco] = model.deltaDecorations(t ? [t.deco] : [], [{ range, options: decoOpts }]);
      tracked.set(i.id, { deco, start, end: i.line, blank: range.endColumn === 1 });
    }
  };
  /** One-line-per-item summary of the live lines; changes when an edit moved any item. */
  const sig = () =>
    [...tracked]
      .map(([id, t]) => {
        const l = live(t);
        return `${id}:${l?.start}-${l?.end}`;
      })
      .join('|');

  const source: ReviewZoneSource<ReviewItem> = {
    kind: 'local',
    ready: () => !!localReviewOf(root),
    subscribe: (changed) => {
      loadLocalReview(root).catch(() => {});
      sync();
      signature = sig();
      const offStore = subscribeLocalReview(root, () => {
        sync();
        signature = sig();
        changed();
      });
      const offContent = model?.onDidChangeContent(() => {
        const s = sig();
        if (s === signature) return;
        signature = s;
        changed();
      });
      const offSave = (() => {
        const fn = (path: string) => {
          if (path !== abs) return;
          for (const [id, t] of tracked) {
            const l = live(t);
            const item = visible().find((i) => i.id === id);
            if (!l || l.gone || !item || item.outdated) continue;
            // the server's line is remapped on read, so what is stored may lag: write each item once per session, then on every move
            const key = `${l.start}-${l.end}:${model?.getLineContent(l.end)}`;
            if (persisted.get(id) === key) continue;
            persisted.set(id, key);
            t.start = l.start;
            t.end = l.end;
            act(H.lrEditItem(root, id, { line: l.end, startLine: l.start < l.end ? l.start : undefined }));
          }
        };
        saveListeners.add(fn);
        return () => saveListeners.delete(fn);
      })();
      return () => {
        offStore();
        offContent?.dispose();
        offSave();
        if (model && !model.isDisposed())
          model.deltaDecorations(
            [...tracked.values()].map((t) => t.deco),
            [],
          );
        tracked.clear();
      };
    },
    items: () =>
      visible().map((i) => {
        const t = tracked.get(i.id);
        const l = t && live(t);
        return l ? { ...i, line: l.end, startLine: l.start < l.end ? l.start : undefined } : i;
      }),
    renderItem: (item, fit) => (
      <Sized onSize={fit}>
        <LocalItemCard item={item} root={root} onSize={fit} />
      </Sized>
    ),
    composer: {
      sides: ['RIGHT'],
      placeholder: 'Leave a comment for the fix list (optionally with a suggestion)',
      submitLabel: 'Add comment',
      submit: async (c) => {
        try {
          await H.lrAddItem(root, {
            path: rel,
            line: c.line,
            startLine: c.startLine != null && c.startLine < c.line ? c.startLine : undefined,
            body: c.body,
            suggestion: c.suggestion,
          });
          await loadLocalReview(root);
          return true;
        } catch (e) {
          toast((e as Error).message);
          return false;
        }
      },
    },
  };
  return showReviewZones(diff, root, rel, source);
}
