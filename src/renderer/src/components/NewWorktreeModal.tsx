import { useEffect, useRef, useState } from 'react';
import { focusAgent } from '../lib/actions';
import { H } from '../lib/legacy';
import { useStore } from '../store';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui';

export function NewWorktreeModal() {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent size="sm">
        <NewWorktreeForm />
      </DialogContent>
    </Dialog>
  );
}

// separate component so the focus effect runs once the dialog content is mounted
function NewWorktreeForm() {
  const repos = useStore((s) => s.app.repos);
  const initialRepo = useStore((s) => s.worktreeRepo);
  const close = useStore((s) => s.closeOverlay);
  const [repo, setRepo] = useState(initialRepo ?? repos[0]?.path ?? '');
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [startAgent, setStartAgent] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const branchRef = useRef<HTMLInputElement>(null);

  useEffect(() => branchRef.current?.focus(), []);
  useEffect(() => {
    let live = true;
    H.currentBranch(repo).then(
      (b) => live && setBase(b),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [repo]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = branch.trim();
    if (!/^[^\s~^:?*[\\]+$/.test(name) || name.includes('..')) {
      setErr('Invalid branch name');
      return;
    }
    setBusy(true);
    try {
      await H.createWorktree({ repo, branch: name, base: base.trim(), startAgent });
      close(false);
      if (startAgent) setTimeout(focusAgent, 400);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="grid gap-4" autoComplete="off" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>New worktree</DialogTitle>
      </DialogHeader>
      {repos.length > 1 && (
        <div className="grid gap-1.5">
          <Label htmlFor="nwRepo">Repository</Label>
          <Select value={repo} onValueChange={setRepo}>
            <SelectTrigger id="nwRepo">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {repos.map((r) => (
                <SelectItem key={r.path} value={r.path}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor="nwBranch">Branch</Label>
        <Input
          id="nwBranch"
          ref={branchRef}
          placeholder="feature/thing"
          spellCheck={false}
          required
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="nwBase">
          Base <span className="text-muted-foreground">— only used if the branch is new</span>
        </Label>
        <Input id="nwBase" spellCheck={false} value={base} onChange={(e) => setBase(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="nwAgent" checked={startAgent} onCheckedChange={setStartAgent} />
        <Label htmlFor="nwAgent">Start an agent in it</Label>
      </div>
      {err && <div className="whitespace-pre-wrap text-destructive text-xs">{err}</div>}
      <DialogFooter>
        <Button variant="ghost" onClick={() => close()}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </DialogFooter>
    </form>
  );
}
