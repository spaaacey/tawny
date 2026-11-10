// Review rail view: review your own branch (docs/local-review-plan.md). Header (base + Review), the branch's changed
// files, and the review items grouped by file, with "Send to agent" / "Clear resolved" at the bottom.
import { ChevronsUpDownIcon, UserIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { ScrollArea } from '@/ui/scroll-area';
import { buildFixPrompt } from '../../../../shared/local-review';
import type { LocalReviewFiles, ReviewItem } from '../../../../shared/types';
import { sendToAgent, toast } from '../../lib/actions';
import { sessionsFor } from '../../lib/selectors';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { openBranchDiff } from '../editor/branchDiff';
import { ChangedFilesList, DIM } from '../review/ChangedFilesList';
import { type ItemBadge, ItemCard } from '../review/ItemCard';
import { useLocalReview } from '../review/localStore';
import { createViewedStore } from '../review/viewed';
import { activeKey, recentTabs } from '../workspace/layoutStore';
import { DoReview } from '../workspace/PrFindings';
import { useTree } from './store';

/** worktree path -> viewed file paths */
const viewedStore = createViewedStore('localReviewViewed');

const fail = (e: unknown) => toast((e as Error).message);

function badgesOf(it: ReviewItem): ItemBadge[] {
  const out: ItemBadge[] = [];
  if (it.status === 'sent')
    out.push({ label: 'Sent', title: 'Sent to an agent, waiting for it to mark the item fixed' });
  if (it.status === 'fixed') out.push({ label: 'Fixed', title: 'The agent marked this item fixed' });
  if (it.status === 'dismissed') out.push({ label: 'Dismissed' });
  if (it.outdated)
    out.push({
      label: 'Outdated',
      title: 'The code this item pointed at changed; showing its last known line',
      variant: 'outline',
    });
  return out;
}

function Item({
  dir,
  item,
  checked,
  onCheck,
}: {
  dir: string;
  item: ReviewItem;
  checked: boolean;
  onCheck: (on: boolean) => void;
}) {
  const open = item.status === 'open';
  const setStatus = (status: ReviewItem['status']) => H.lrSetStatus(dir, item.id, status).catch(fail);
  return (
    <ItemCard
      item={item}
      canSuggest
      icon={item.source === 'user' ? <UserIcon className="size-3.5 text-muted-foreground" /> : undefined}
      label={item.source === 'user' ? 'Your comment' : 'Agent finding'}
      leading={
        open ? (
          <Checkbox
            className="border-foreground"
            checked={checked}
            onCheckedChange={(c) => onCheck(c === true)}
            aria-label={`Include ${item.path}:${item.line} when sending`}
          />
        ) : undefined
      }
      onJump={() => openBranchDiff(dir, `${dir}/${item.path}`, { line: item.line }).catch(fail)}
      badges={badgesOf(item)}
      actions={(ctx) => (
        <>
          {(open || item.status === 'sent') && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                if (ctx.editing)
                  H.lrEditItem(dir, item.id, {
                    body: ctx.draft.body,
                    detail: '',
                    suggestion: ctx.draft.suggestion,
                  }).catch(fail);
                ctx.toggleEdit();
              }}
            >
              {ctx.editing ? 'Done editing' : 'Edit'}
            </Button>
          )}
          {item.status !== 'dismissed' && item.status !== 'fixed' && (
            <Button variant="ghost" size="xs" onClick={() => setStatus('dismissed')}>
              Dismiss
            </Button>
          )}
          {item.status !== 'open' && (
            <Button variant="ghost" size="xs" onClick={() => setStatus('open')}>
              Reopen
            </Button>
          )}
        </>
      )}
    >
      {item.status === 'fixed' && item.note && (
        <p className="text-xs">
          <span className="font-medium">Fixed: </span>
          {item.note}
        </p>
      )}
    </ItemCard>
  );
}

/** Chat picker + "Send N to agent". Default target: the most recently active non-review chat. */
function SendBar({ dir, items, ids }: { dir: string; items: ReviewItem[]; ids: string[] }) {
  const app = useStore((s) => s.app);
  const state = useLocalReview(dir);
  const [picked, setPicked] = useState('');
  const wt = app.repos.flatMap((r) => r.worktrees).find((w) => w.path === dir);
  const chats = wt
    ? sessionsFor(app, wt).filter((s) => s.kind !== 'terminal' && !state?.reviewChats.includes(s.id))
    : [];
  const recent = recentTabs()
    .filter((k) => k.startsWith('a:'))
    .map((k) => k.slice(2));
  const rank = (id: string) => {
    const i = recent.indexOf(id);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const target = chats.find((c) => c.id === picked) ?? [...chats].sort((a, b) => rank(a.id) - rank(b.id))[0];
  const label = (c: { title: string | null; name: string | null; index: number }) =>
    c.title || c.name || `agent ${c.index}`;
  const n = ids.length;
  const send = async () => {
    if (!target) return toast('No chat to send to. Start an agent chat first.');
    const picked = items.filter((i) => ids.includes(i.id));
    await sendToAgent(buildFixPrompt(picked), target.id);
    await H.lrMarkSent(dir, ids);
  };
  return (
    <div className="flex flex-wrap items-center gap-1 border-t px-2 py-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="xs"
            className="max-w-40"
            title="Chat that gets the fix prompt"
            disabled={!chats.length}
          >
            <span className="truncate">{target ? label(target) : 'No chats'}</span>
            <ChevronsUpDownIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuRadioGroup value={target?.id ?? ''} onValueChange={setPicked}>
            {chats.map((c) => (
              <DropdownMenuRadioItem key={c.id} value={c.id}>
                {label(c)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        size="xs"
        disabled={!n || !target}
        title="Put the fix prompt in the chat's composer (not sent)"
        onClick={() => send().catch(fail)}
      >
        Send {n} to agent
      </Button>
    </div>
  );
}

export function ReviewView() {
  const dir = useTree((s) => s.root);
  if (!dir) return null;
  return <Body key={dir} dir={dir} />;
}

function Body({ dir }: { dir: string }) {
  const state = useLocalReview(dir);
  const [files, setFiles] = useState<LocalReviewFiles | null>(null);
  const [err, setErr] = useState('');
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
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
  const byFile = new Map<string, ReviewItem[]>();
  for (const it of items)
    byFile.set(
      it.path,
      [...(byFile.get(it.path) ?? []), it].sort((a, b) => a.line - b.line),
    );
  const checkedIds = items.filter((i) => i.status === 'open' && !unchecked.has(i.id)).map((i) => i.id);
  const resolved = items.filter((i) => i.status === 'fixed' || i.status === 'dismissed').length;

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
            files={files?.files ?? []}
            viewedId={dir}
            viewedStore={viewedStore}
            title="Branch changes"
            emptyText={files ? 'No changes against the base' : 'Loading…'}
            onOpen={(f, pin) => openBranchDiff(dir, `${dir}/${f.path}`, { pin }).catch(fail)}
            isActive={(f) => activeKey() === `d:b:${dir}/${f.path}`}
            count={(p) => byFile.get(p)?.length ?? 0}
            countTitle={(n) => `${n} review item${n > 1 ? 's' : ''}`}
          />
        )}
        <div className="cn-head">Review items ({items.length})</div>
        {!items.length && <div className="tree-empty">No items yet. Press Review to run /code-review.</div>}
        <div className="flex flex-col gap-3 p-2 pt-1">
          {[...byFile].map(([path, list]) => (
            <section key={path} className="flex flex-col gap-2">
              <h3 className={`truncate font-mono text-xs ${DIM}`} title={path}>
                {path}
              </h3>
              {list.map((it) => (
                <Item
                  key={it.id}
                  dir={dir}
                  item={it}
                  checked={!unchecked.has(it.id)}
                  onCheck={(on) =>
                    setUnchecked((u) => {
                      const n = new Set(u);
                      if (on) n.delete(it.id);
                      else n.add(it.id);
                      return n;
                    })
                  }
                />
              ))}
            </section>
          ))}
        </div>
      </ScrollArea>
      {items.length > 0 && (
        <>
          <SendBar dir={dir} items={items} ids={checkedIds} />
          <div className="flex border-t px-2 py-1">
            <Button
              variant="ghost"
              size="xs"
              disabled={!resolved}
              title="Remove fixed and dismissed items"
              onClick={() => H.lrClearResolved(dir).catch(fail)}
            >
              Clear resolved{resolved ? ` (${resolved})` : ''}
            </Button>
          </div>
        </>
      )}
    </>
  );
}
