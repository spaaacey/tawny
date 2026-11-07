import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/ui/dialog';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
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
      await openPrReview(v, instr ?? undefined);
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
        <div className="flex items-center justify-between">
          <Label htmlFor="prInstr">Agent instructions</Label>
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
        <Textarea
          id="prInstr"
          className="max-h-64 font-mono text-xs"
          spellCheck={false}
          disabled={instr === null}
          value={instr ?? ''}
          onChange={(e) => setInstr(e.target.value)}
        />
        <div className="text-muted-foreground text-xs">
          Sent to the agent when the review chat starts. Filled in per PR:{' '}
          {'{owner} {repo} {number} {title} {url} {headSha} {baseSha}'}
        </div>
      </div>
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
