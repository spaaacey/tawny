// Agent findings of a PR session (from /code-review's ReportFindings and `tawny pr propose-comment`):
// the list in the PR tab, the card also drawn in the diff, and the "Do review" dialog that starts /code-review.
import { PlayIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { ItemGroup } from '@/ui/item';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import type { PrEffort, PrFinding } from '../../../../shared/types';
import { refreshState, toast } from '../../lib/actions';
import { sessionsFor } from '../../lib/selectors';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { tawnyChat } from '../chat';
import { openDiff, openFile } from '../editor/api';
import { prSnapshotChanged } from '../editor/prBus';
import { type ItemBadge, ItemCard, ItemRow, itemWhere } from '../review/ItemCard';
import { revealReviewLine } from '../review/reveal';
import { expectAgent, focusedGroup, revealAgent } from './layoutStore';

export const EFFORTS: PrEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Findings of PR worktree `dir`, kept in step with main. */
export function usePrFindings(dir: string | undefined) {
  const [list, setList] = useState<PrFinding[]>([]);
  useEffect(() => {
    if (!dir) return;
    let dead = false;
    const load = () =>
      H.prFindings(dir)
        .then((l) => !dead && setList(l))
        .catch(() => {});
    setList([]);
    load();
    const off = H.onPrFindings((p) => p === dir && load());
    return () => {
      dead = true;
      off();
    };
  }, [dir]);
  return list;
}

/** The PR head moved since the finding was made, or its anchor lines are gone from the worktree file (main remaps). */
export const isOutdated = (f: PrFinding, headSha: string | undefined) =>
  !!f.outdated || (!!headSha && !!f.headSha && f.headSha !== headSha);

/** Open the finding's file in the PR diff at its line (plain file if it isn't part of the diff). */
export async function jumpToFinding(dir: string, f: PrFinding) {
  const files = await H.prFiles(dir);
  if (files.files.some((x) => x.path === f.path)) {
    await openDiff('r', `${files.base}:${dir}/${f.path}`, { pin: true });
    revealReviewLine('pr', dir, f.path, f.line);
  } else await openFile(`${dir}/${f.path}`, { pin: true, selection: { lineNumber: f.line, column: 1 } });
}

/** "Add to review": draft the finding as a thread in the GitHub pending review (main builds it: ReportFindings -> single line, RIGHT, body = summary + failure scenario). `edit` carries the user's edited text. */
export async function addToReview(dir: string, f: PrFinding, edit?: { body: string; suggestion?: string }) {
  prSnapshotChanged(dir, await H.prFindingAdd(dir, f.id, edit));
}

const _where = itemWhere;

/** A PR finding as an ItemCard: PR badges plus Add to review / Edit / Dismiss. */
export function FindingCard({
  f,
  dir,
  outdated,
  onJump,
  onSize,
}: {
  f: PrFinding;
  dir: string;
  outdated: boolean;
  onJump?: () => void;
  onSize?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const act = (p: Promise<unknown>) => p.catch((e: Error) => toast(e.message));
  const badges: ItemBadge[] = [];
  if (outdated)
    badges.push({ label: 'Outdated', variant: 'outline', title: 'The PR head moved since this finding was made' });
  if (f.status === 'accepted') badges.push({ label: 'Added to review' });
  return (
    <ItemCard
      item={f}
      onJump={onJump}
      onSize={onSize}
      badges={badges}
      canSuggest={f.side === 'RIGHT'}
      actions={({ editing, draft, toggleEdit }) =>
        f.status === 'open' && (
          <>
            <Button
              size="xs"
              disabled={busy || (editing && !draft.body.trim())}
              onClick={async () => {
                setBusy(true);
                await act(
                  addToReview(
                    dir,
                    f,
                    editing
                      ? { body: draft.body, suggestion: f.side === 'RIGHT' ? draft.suggestion : undefined }
                      : undefined,
                  ),
                );
                setBusy(false);
              }}
            >
              Add to review
            </Button>
            <Button size="xs" variant="outline" onClick={toggleEdit}>
              {editing ? 'Done editing' : 'Edit'}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => act(H.prFindingStatus(dir, f.id, 'dismissed'))}>
              Dismiss
            </Button>
          </>
        )
      }
    />
  );
}

/** The "Findings" section of the PR tab. */
export function FindingsSection({ dir, headSha }: { dir: string; headSha?: string }) {
  const all = usePrFindings(dir);
  const list = all.filter((f) => f.status === 'open');
  const dismissed = all.filter((f) => f.status === 'dismissed').length;
  if (!list.length && !dismissed) return null;
  const byFile = new Map<string, PrFinding[]>();
  for (const f of list) byFile.set(f.path, [...(byFile.get(f.path) ?? []), f]);
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
        Agent findings ({list.length}
        {dismissed ? `, ${dismissed} dismissed` : ''})
      </h2>
      {[...byFile].map(([path, fs]) => (
        <div key={path} className="flex flex-col gap-2">
          {fs.map((f) => (
            <FindingCard
              key={f.id}
              f={f}
              dir={dir}
              outdated={isOutdated(f, headSha)}
              onJump={() => jumpToFinding(dir, f).catch((e: Error) => toast(e.message))}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

/** "Do review": instructions and effort pre-filled from the prReview settings, editable per run, then `/code-review <effort> <instructions>` goes to the PR chat. Never --comment/--fix. */
export function DoReview({
  chatId,
  local,
}: {
  chatId?: string | undefined;
  /** local review of worktree `dir`: also picks the diff base, then starts a dedicated review chat (docs/local-review-plan.md) */
  local?: { dir: string; base: string };
}) {
  const settings = useStore((s) => s.app.settings);
  const [open, setOpen] = useState(false);
  const [effort, setEffort] = useState<PrEffort>('medium');
  const [instructions, setInstructions] = useState('');
  const [base, setBase] = useState('');
  const [custom, setCustom] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const start = (o: boolean) => {
    if (o) {
      if (local) {
        setBase(local.base);
        setCustom('');
        H.gitBranches(local.dir).then(
          (b) => setBranches(b.map((x) => x.name)),
          () => {},
        );
      }
      const e = settings['prReview.effort'];
      setEffort(EFFORTS.includes(e) ? e : 'medium');
      setInstructions(settings['prReview.instructions'] ?? '');
    }
    setOpen(o);
  };
  const runLocal = async () => {
    if (!local) return;
    const want = custom.trim() || base;
    const opts = { effort, instructions: instructions.replace(/\s*\n\s*/g, ' ').trim() };
    setOpen(false);
    try {
      if (want && want !== local.base) await H.lrSetBase(local.dir, want);
      expectAgent(focusedGroup());
      const r = await H.lrStartReview(local.dir, opts);
      await refreshState();
      expectAgent(null);
      revealAgent(r.chatId);
    } catch (e) {
      expectAgent(null);
      toast((e as Error).message);
    }
  };
  const run = () => {
    if (local) return void runLocal();
    if (!chatId) return toast('This PR session has no chat');
    const text = `/code-review ${effort} ${instructions.replace(/\s*\n\s*/g, ' ').trim()}`.trim();
    if (!tawnyChat.send(chatId, text)) return toast('The chat is not ready yet');
    setOpen(false);
  };
  return (
    <>
      {local ? (
        <Button size="xs" title="Review this branch's changes" onClick={() => start(true)}>
          <PlayIcon /> Review
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-full text-muted-foreground"
          title="Do review"
          aria-label="Do review"
          disabled={!chatId}
          onClick={() => start(true)}
        >
          <PlayIcon />
        </Button>
      )}
      <Dialog open={open} onOpenChange={start}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{local ? 'Review this branch' : 'Do review'}</DialogTitle>
            <DialogDescription>
              {local
                ? 'Runs /code-review in a new review chat. Findings appear in the Review view; nothing is edited.'
                : "Runs /code-review in this PR's chat. Findings appear here; nothing is posted to GitHub."}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {local && (
              <Field>
                <FieldLabel>Compare against</FieldLabel>
                <Select value={base} onValueChange={setBase}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([local.base, ...branches])].map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={custom}
                  spellCheck={false}
                  placeholder="Or a commit / ref, e.g. abc1234 or origin/main"
                  aria-label="Commit or ref to compare against"
                  onChange={(e) => setCustom(e.target.value)}
                />
                <FieldDescription>Reviews the merge-base with this ref up to your working tree.</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel>Effort</FieldLabel>
              <Select value={effort} onValueChange={(v) => setEffort(v as PrEffort)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EFFORTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Instructions</FieldLabel>
              <Textarea
                value={instructions}
                rows={4}
                placeholder="Optional focus, e.g. look at error handling and migrations"
                onChange={(e) => setInstructions(e.target.value)}
              />
              <FieldDescription>
                Defaults come from the prReview.instructions and prReview.effort settings.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={run}>Run review</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The PR worktree whose chat is `chatId` (undefined for any other chat). */
function usePrChatDir(chatId: string) {
  return useStore(
    (s) =>
      s.app.repos.flatMap((r) => r.worktrees).find((w) => w.pr && sessionsFor(s.app, w).some((x) => x.id === chatId))
        ?.path,
  );
}

/** Body of a ReportFindings tool call in a PR chat: its findings with live status, Jump and Dismiss (same store as the diff cards). */
export function ReportedFindings({ chatId, toolCallId }: { chatId: string; toolCallId: string }) {
  const dir = usePrChatDir(chatId);
  const all = usePrFindings(dir);
  if (!dir) return null;
  const mine = all.filter((f) => f.id.startsWith(`r-${toolCallId}-`));
  if (!mine.length) return null;
  return (
    <ItemGroup className="mt-1 gap-1">
      {mine.map((f) => (
        <ItemRow
          key={f.id}
          item={f}
          struck={f.status === 'dismissed'}
          badges={
            f.status === 'accepted'
              ? [{ label: 'Added to review' }]
              : f.status === 'dismissed'
                ? [{ label: 'Dismissed', variant: 'outline' }]
                : []
          }
          actions={
            <>
              <Button
                size="xs"
                variant="outline"
                onClick={() => jumpToFinding(dir, f).catch((e: Error) => toast(e.message))}
              >
                Jump
              </Button>
              {f.status === 'open' && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => H.prFindingStatus(dir, f.id, 'dismissed').catch((e: Error) => toast(e.message))}
                >
                  Dismiss
                </Button>
              )}
            </>
          }
        />
      ))}
    </ItemGroup>
  );
}
