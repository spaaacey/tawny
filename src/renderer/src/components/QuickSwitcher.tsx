import { useEffect, useMemo, useRef, useState } from 'react';
import { activate } from '../lib/actions';
import { allWorkspaces, sessionsFor, workspaceLabel } from '../lib/selectors';
import { useStore } from '../store';
import { Indicator } from './Indicator';
import { TopDialogContent } from './Overlay';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command';
import { Dialog, DialogTitle } from './ui/dialog';

export function QuickSwitcher() {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <TopDialogContent>
        <DialogTitle className="sr-only">Switch worktree</DialogTitle>
        <Switcher />
      </TopDialogContent>
    </Dialog>
  );
}

function Switcher() {
  const app = useStore((s) => s.app);
  const close = useStore((s) => s.closeOverlay);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const items = useMemo(() => {
    const needle = q.toLowerCase();
    return allWorkspaces(app).filter(
      (w) => !needle || `${workspaceLabel(w)} ${w.repoName}`.toLowerCase().includes(needle),
    );
  }, [app, q]);
  const cur = Math.min(sel, Math.max(0, items.length - 1));

  const pick = (i: number) => {
    const w = items[i];
    close(false);
    if (w) activate(w.path);
  };

  return (
    <Command
      value={items[cur]?.path}
      onValueChange={(v) =>
        setSel(
          Math.max(
            0,
            items.findIndex((w) => w.path === v),
          ),
        )
      }
    >
      <CommandInput
        ref={input}
        spellCheck={false}
        placeholder="Switch to worktree…"
        value={q}
        onValueChange={(v) => {
          setQ(v);
          setSel(0);
        }}
      />
      <CommandList className="max-h-[50vh]">
        <CommandEmpty>No matches</CommandEmpty>
        {items.map((w) => {
          const ss = sessionsFor(app, w);
          return (
            <CommandItem key={w.path} value={w.path} onSelect={() => pick(items.indexOf(w))}>
              <div className="qrow">
                <Indicator
                  waiting={ss.some((s) => s.waiting)}
                  working={ss.some((s) => s.working)}
                  any={ss.length > 0}
                />
                <span>{workspaceLabel(w)}</span>
                <span className="r">
                  {w.repoName}
                  {w.path === app.active ? ' · open' : ''}
                </span>
              </div>
            </CommandItem>
          );
        })}
      </CommandList>
    </Command>
  );
}
