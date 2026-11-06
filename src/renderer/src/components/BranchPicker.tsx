import { useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/ui/command';
import { Dialog, DialogTitle } from '@/ui/dialog';
import { activate, toast } from '../lib/actions';
import { activeWorkspace, allWorkspaces } from '../lib/selectors';
import { H } from '../lib/tawny';
import { useStore } from '../store';
import { Branch } from './icons';
import { TopDialogContent } from './Overlay';

type Branches = Awaited<ReturnType<typeof H.gitBranches>>;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Status-bar branch button: switch this worktree's branch, or jump to the workspace that has it checked out. */
export function BranchPicker() {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <TopDialogContent>
        <DialogTitle className="sr-only">Switch branch</DialogTitle>
        <Picker />
      </TopDialogContent>
    </Dialog>
  );
}

function Picker() {
  const app = useStore((s) => s.app);
  const close = useStore((s) => s.closeOverlay);
  const ws = activeWorkspace(app);
  const [branches, setBranches] = useState<Branches>([]);
  const [fail, setFail] = useState<{ branch: string; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (ws) H.gitBranches(ws.path).then(setBranches, (e) => toast(errMsg(e)));
  }, [ws?.path]);
  if (!ws) return null;

  const sw = async (branch: string, stash: boolean) => {
    setBusy(true);
    try {
      const stashed = await H.gitSwitch(ws.path, branch, stash);
      close();
      if (stashed) toast(`Stashed your changes as "tawny: ${ws.branch || 'detached HEAD'}"`);
    } catch (e) {
      setFail({
        branch,
        msg: errMsg(e)
          .replace(/^Command failed:.*\n/, '')
          .trim(),
      });
    }
    setBusy(false);
  };
  const pick = (b: Branches[number]) => {
    if (b.current) return close();
    if (!b.worktree) return void sw(b.name, false);
    const target = allWorkspaces(app).find((w) => w.path === b.worktree);
    close(false);
    if (target) activate(target.path);
    else toast(`${b.name} is checked out in ${b.worktree}, which isn't a workspace`);
  };

  return (
    <Command>
      <CommandInput ref={input} spellCheck={false} placeholder="Switch branch…" onValueChange={() => setFail(null)} />
      {fail ? (
        <div className="flex items-start gap-2 border-b px-3 py-2 text-xs">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap break-words text-muted-foreground">{fail.msg}</pre>
          <Button size="sm" disabled={busy} onClick={() => sw(fail.branch, true)}>
            Stash &amp; switch
          </Button>
        </div>
      ) : null}
      <CommandList className="max-h-[50vh]">
        <CommandEmpty>No matches</CommandEmpty>
        {branches.map((b) => (
          <CommandItem key={b.name} value={b.name} onSelect={() => pick(b)}>
            <div className="qrow">
              <Branch />
              <span>{b.name}</span>
              <span className="r">
                {b.current ? 'current' : b.worktree ? `worktree · ${b.worktree.split('/').pop()}` : ''}
              </span>
            </div>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
