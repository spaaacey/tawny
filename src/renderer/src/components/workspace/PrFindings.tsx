// Agent findings of a PR session (from /code-review's ReportFindings and `tawny pr propose-comment`):
// the list in the PR tab, the card also drawn in the diff, and the "Do review" dialog that starts /code-review.
import { BotIcon, ChevronRightIcon, PlayIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader } from '@/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import type { PrEffort, PrFinding } from '../../../../shared/types';
import { toast } from '../../lib/actions';
import { H } from '../../lib/tawny';
import { useStore } from '../../store';
import { tawnyChat } from '../chat';
import { openDiff, openFile } from '../editor/api';
import { prSnapshotChanged } from '../editor/prBus';
import { revealPrLine } from '../editor/prReveal';
import { Md } from './prParts';

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

export const isOutdated = (f: PrFinding, headSha: string | undefined) =>
  !!headSha && !!f.headSha && f.headSha !== headSha;

/** Open the finding's file in the PR diff at its line (plain file if it isn't part of the diff). */
export async function jumpToFinding(dir: string, f: PrFinding) {
  const files = await H.prFiles(dir);
  if (files.files.some((x) => x.path === f.path)) {
    await openDiff('r', `${files.base}:${dir}/${f.path}`, { pin: true });
    revealPrLine(dir, f.path, f.line);
  } else await openFile(`${dir}/${f.path}`, { pin: true, selection: { lineNumber: f.line, column: 1 } });
}

/** "Add to review": draft the finding as a thread in the GitHub pending review (main builds it: ReportFindings -> single line, RIGHT, body = summary + failure scenario). `edit` carries the user's edited text. */
export async function addToReview(dir: string, f: PrFinding, edit?: { body: string; suggestion?: string }) {
  prSnapshotChanged(dir, await H.prFindingAdd(dir, f.id, edit));
}

const where = (f: PrFinding) => `${f.path}:${f.startLine ? `${f.startLine}-` : ''}${f.line}`;

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
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(f.detail ? `${f.body}\n\n${f.detail}` : f.body);
  const [sugg, setSugg] = useState(f.suggestion ?? '');
  const [busy, setBusy] = useState(false);
  const act = (p: Promise<unknown>) => p.catch((e: Error) => toast(e.message));
  const add = async () => {
    setBusy(true);
    await act(addToReview(dir, f, editing ? { body, suggestion: f.side === 'RIGHT' ? sugg : undefined } : undefined));
    setBusy(false);
  };
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 px-3 py-1.5">
        <BotIcon className="size-3.5 text-muted-foreground" />
        {onJump ? (
          <button
            type="button"
            className="cursor-pointer font-mono text-xs underline-offset-2 hover:underline"
            onClick={onJump}
          >
            {where(f)}
          </button>
        ) : (
          <span className="text-xs font-medium">Agent finding</span>
        )}
        <span className="flex-1" />
        {f.category && <Badge variant="outline">{f.category}</Badge>}
        {f.verdict && <Badge variant="secondary">{f.verdict}</Badge>}
        {outdated && (
          <Badge variant="outline" title="The PR head moved since this finding was made">
            Outdated
          </Badge>
        )}
        {f.status === 'accepted' && <Badge variant="secondary">Added to review</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-2 border-t px-3 py-2">
        {editing ? (
          <>
            <Textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
            />
            {f.side === 'RIGHT' && (
              <Textarea
                rows={2}
                className="font-mono text-xs"
                placeholder="Suggested replacement for the selected lines (optional)"
                value={sugg}
                onChange={(e) => setSugg(e.target.value)}
              />
            )}
          </>
        ) : (
          <Md text={f.body} />
        )}
        {!editing && f.suggestion && (
          <pre className="overflow-x-auto rounded bg-muted p-2 font-mono text-xs">{f.suggestion}</pre>
        )}
        {!editing && f.detail && (
          <Collapsible
            open={open}
            onOpenChange={(o) => {
              setOpen(o);
              requestAnimationFrame(() => onSize?.());
            }}
          >
            <CollapsibleTrigger asChild>
              <button type="button" className="flex cursor-pointer items-center gap-1 text-muted-foreground text-xs">
                <ChevronRightIcon className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`} />
                Failure scenario
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-1">
              <Md text={f.detail} />
            </CollapsibleContent>
          </Collapsible>
        )}
        {f.status === 'open' && (
          <div className="flex gap-2">
            <Button size="xs" disabled={busy || (editing && !body.trim())} onClick={add}>
              Add to review
            </Button>
            <Button size="xs" variant="outline" onClick={() => setEditing((e) => !e)}>
              {editing ? 'Done editing' : 'Edit'}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => act(H.prFindingStatus(dir, f.id, 'dismissed'))}>
              Dismiss
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The "Findings" section of the PR tab. */
export function FindingsSection({ dir, headSha }: { dir: string; headSha?: string }) {
  const all = usePrFindings(dir);
  const list = all.filter((f) => f.status !== 'dismissed');
  const dismissed = all.length - list.length;
  if (!all.length) return null;
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
export function DoReview({ chatId }: { chatId: string | undefined }) {
  const settings = useStore((s) => s.app.settings);
  const [open, setOpen] = useState(false);
  const [effort, setEffort] = useState<PrEffort>('medium');
  const [instructions, setInstructions] = useState('');
  const start = (o: boolean) => {
    if (o) {
      const e = settings['prReview.effort'];
      setEffort(EFFORTS.includes(e) ? e : 'medium');
      setInstructions(settings['prReview.instructions'] ?? '');
    }
    setOpen(o);
  };
  const run = () => {
    if (!chatId) return toast('This PR session has no chat');
    const text = `/code-review ${effort} ${instructions.replace(/\s*\n\s*/g, ' ').trim()}`.trim();
    if (!tawnyChat.send(chatId, text)) return toast('The chat is not ready yet');
    setOpen(false);
  };
  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className="h-[20px] rounded-full text-muted-foreground"
        disabled={!chatId}
        onClick={() => start(true)}
      >
        <PlayIcon />
        Do review
      </Button>
      <Dialog open={open} onOpenChange={start}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Do review</DialogTitle>
            <DialogDescription>
              Runs /code-review in this PR's chat. Findings appear here; nothing is posted to GitHub.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
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
