import { useEffect, useMemo, useRef, useState } from 'react';
import { activate, focusTerm } from '../lib/actions';
import { allWorkspaces, attentionItems, sessionsFor, workspaceLabel } from '../lib/selectors';
import { useStore } from '../store';
import { Indicator } from './Indicator';
import { TopDialogContent } from './Overlay';
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from './ui/command';
import { Dialog, DialogTitle } from './ui/dialog';
import { revealAgent } from './workspace/layoutStore';
import { agentLabel } from './workspace/panes';

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

export function SessionSwitcher() {
  const close = useStore((s) => s.closeOverlay);
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <TopDialogContent>
        <DialogTitle className="sr-only">Switch session</DialogTitle>
        <Sessions />
      </TopDialogContent>
    </Dialog>
  );
}

function Sessions() {
  const app = useStore((s) => s.app);
  const focusedSession = useStore((s) => s.focusedSession);
  const unread = useStore((s) => s.unread);
  const close = useStore((s) => s.closeOverlay);
  const openOverlay = useStore((s) => s.openOverlay);
  const cycle = useStore((s) => s.sessionCycle);
  const setCycle = useStore((s) => s.setSessionCycle);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  // sessions needing attention first, then the rest in workspace order
  const items = useMemo(() => {
    const attn = new Set(attentionItems(app, unread, focusedSession).map((it) => it.s.id));
    const all = allWorkspaces(app).flatMap((w) =>
      sessionsFor(app, w).map((s) => ({ w, s, label: agentLabel(s) as string })),
    );
    return [...all.filter((it) => attn.has(it.s.id)), ...all.filter((it) => !attn.has(it.s.id))];
  }, [app.sessions.length]);
  const value = (it: (typeof items)[number]) => `${it.s.id} ${it.label} ${it.s.summary ?? ''} ${workspaceLabel(it.w)}`;
  // cmd+tab style: the first step skips the session you are already on
  const [sel, setSel] = useState<string | undefined>();
  const start = items[0]?.s.id === focusedSession ? 1 : 0;
  useEffect(() => {
    if (!cycle || !items.length) return;
    const n = cycle.n;
    const base = n > 0 ? start + n - 1 : items.length + n;
    setSel(value(items[((base % items.length) + items.length) % items.length]));
  }, [cycle?.n]);

  // cycle mode: releasing cmd commits the highlighted session; any other key (typing, arrows) leaves cycle mode
  useEffect(() => {
    if (!cycle) return;
    const up = (e: KeyboardEvent) => {
      if (e.key !== 'Meta' && e.key !== 'Control') return;
      const it = items.find((i) => value(i) === sel);
      if (it) void pick(it);
      else close();
    };
    const down = (e: KeyboardEvent) => {
      if (['Meta', 'Control', 'Shift', 'Alt', '`', '~'].includes(e.key)) return;
      setCycle(null);
    };
    addEventListener('keyup', up);
    addEventListener('keydown', down);
    return () => {
      removeEventListener('keyup', up);
      removeEventListener('keydown', down);
    };
  });

  const pick = async (it: (typeof items)[number]) => {
    close(false);
    await activate(it.w.path);
    revealAgent(it.s.id);
    focusTerm(it.s.id);
  };

  return (
    <Command
      value={sel}
      onValueChange={setSel}
      onKeyDown={(e) => {
        const el = input.current;
        if (
          e.key === 'ArrowRight' &&
          el &&
          el.selectionStart === el.value.length &&
          el.selectionEnd === el.value.length
        ) {
          e.preventDefault();
          openOverlay('quick');
        }
      }}
    >
      <CommandInput ref={input} spellCheck={false} placeholder="Switch to session…" />
      <CommandList className="max-h-[50vh]">
        <CommandEmpty>No matches</CommandEmpty>
        {items.map((it) => (
          <CommandItem key={it.s.id} value={value(it)} onSelect={() => pick(it)}>
            <div className="qrow">
              <Indicator waiting={!!it.s.waiting} working={!!it.s.working} unread={unread.has(it.s.id)} any />
              <span>{it.label}</span>
              <span className="r">
                {workspaceLabel(it.w)}
                {it.s.id === focusedSession ? ' · open' : ''}
              </span>
            </div>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}
