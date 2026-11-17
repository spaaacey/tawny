import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/ui/select';
import { Textarea } from '@/ui/textarea';
import { DEFAULT_PR_INSTRUCTIONS } from '../../../shared/pr-instructions';
import { openPrReview } from '../lib/actions';
import { H } from '../lib/tawny';
import { useStore } from '../store';

export function PrReviewModal() {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent showCloseButton={false} aria-describedby={undefined} className="sm:max-w-[560px]">
        <PrReviewForm />
      </DialogContent>
    </Dialog>
  );
}

function PrReviewForm() {
  const close = useStore((s) => s.closeOverlay);
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');
  const [instr, setInstr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [host, setHost] = useState('new');
  const repos = useStore((s) => s.app.repos);
  const worktrees = repos.flatMap((r) => r.worktrees.map((w) => ({ ...w, repoName: r.name })));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    H.prInstructions().then(setInstr, () => setInstr(DEFAULT_PR_INSTRUCTIONS));
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = ref.trim();
    if (!v) {
      setErr('Enter a PR URL or #N');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await openPrReview(v, instr ?? undefined, host === 'new' ? undefined : host);
      close(false);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-4" autoComplete="off" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Review pull request</DialogTitle>
      </DialogHeader>
      <div className="grid gap-1.5">
        <Label htmlFor="prRef">PR URL or #N</Label>
        <Input
          id="prRef"
          ref={inputRef}
          placeholder="https://github.com/owner/repo/pull/123 or #123"
          spellCheck={false}
          value={ref}
          onChange={(e) => setRef(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="prHost">Review in</Label>
        <Select value={host} onValueChange={setHost}>
          <SelectTrigger id="prHost" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">New worktree</SelectItem>
            {worktrees
              .filter((w) => !w.prunable && (!w.pr || w.pr.hosted))
              .map((w) => (
                <SelectItem key={w.path} value={w.path}>
                  {w.repoName} · {w.branch || 'detached HEAD'}
                  {w.pr ? ` (PR #${w.pr.number})` : ''}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {host !== 'new' && (
          <div className="text-muted-foreground text-xs">
            Switches that worktree to the PR's branch unless it is already there. Refused if it has uncommitted changes.
          </div>
        )}
      </div>
      <Collapsible className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm">
              Customize agent instructions
            </Button>
          </CollapsibleTrigger>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={instr === DEFAULT_PR_INSTRUCTIONS}
            onClick={() => setInstr(DEFAULT_PR_INSTRUCTIONS)}
          >
            Reset
          </Button>
        </div>
        <CollapsibleContent className="grid gap-1.5">
          <Label htmlFor="prInstr" className="sr-only">
            Agent instructions
          </Label>
          <Textarea
            id="prInstr"
            className="max-h-64 font-mono text-xs"
            spellCheck={false}
            disabled={instr === null}
            value={instr ?? ''}
            onChange={(e) => setInstr(e.target.value)}
          />
          <div className="text-muted-foreground text-xs">
            Placeholders like {'{owner}'} and {'{title}'} are filled in automatically for each PR.
          </div>
        </CollapsibleContent>
      </Collapsible>
      {err && <div className="whitespace-pre-wrap text-destructive text-xs">{err}</div>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" variant="default" disabled={busy}>
          {busy ? 'Opening…' : 'Review'}
        </Button>
      </DialogFooter>
    </form>
  );
}
