import { useEffect, useLayoutEffect } from 'react';
import { Input } from '@/ui/input';
import { Item, ItemContent, ItemGroup, ItemMedia } from '@/ui/item';
import type { Leaf } from './layoutStore';
import {
  launchHint,
  lqChanged,
  lqKeyDown,
  markFocused,
  placeholderFor,
  regFor,
  runLaunch,
  useUiTick,
  wantLauncherFocus,
} from './panes';

/** The new-tab / empty-pane picker: kinds, then fuzzy file matches. State lives on the group's record in panes.ts. */
export function Launcher({ g, hidden }: { g: Leaf; hidden: boolean }) {
  useUiTick((s) => s.tick);
  const reg = regFor(g.id);
  const hint = launchHint(reg);

  useLayoutEffect(() => {
    if (reg.lq && reg.lq.value !== reg.lqText) reg.lq.value = reg.lqText;
  });
  useEffect(() => {
    if (!hidden && wantLauncherFocus.delete(g.id)) reg.lq?.focus();
  });
  useEffect(() => {
    reg.lq?.closest('.glaunch')?.querySelector('.lopt.sel')?.scrollIntoView({ block: 'nearest' });
  }, [reg, reg.lsel, reg.litems]);

  return (
    <div
      className="glaunch center-msg"
      hidden={hidden}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t !== reg.lq && !t.closest('.lopt')) {
          e.preventDefault();
          reg.lq?.focus();
        }
      }}
    >
      <div className="lbox">
        <Input
          className="lq h-auto px-3 py-[9px] text-sm md:text-sm"
          spellCheck={false}
          autoComplete="off"
          aria-label="New tab"
          ref={(el) => {
            reg.lq = el;
          }}
          placeholder={placeholderFor(reg)}
          onChange={(e) => lqChanged(g, e.target.value)}
          onKeyDown={lqKeyDown(g)}
        />
        <ItemGroup className="lopts gap-0.5 rounded-lg border bg-card p-1">
          {reg.litems.map((it, i) => {
            const Icon = it.icon;
            return (
              <Item
                key={i}
                size="sm"
                className={`lopt qi cursor-pointer gap-3 px-3 py-2${i === reg.lsel ? ' sel bg-accent text-accent-foreground' : ' hover:bg-accent/50'}`}
                data-i={i}
                onMouseDown={(e) => {
                  e.preventDefault();
                  markFocused(g.id);
                  runLaunch(g, i);
                }}
              >
                {Icon && (
                  <ItemMedia>
                    <Icon className="size-4 text-muted-foreground" />
                  </ItemMedia>
                )}
                <ItemContent className="qrow min-w-0 flex-row items-center gap-3">{it.node}</ItemContent>
              </Item>
            );
          })}
          {hint && <div className="lopt qi muted px-3 py-2 text-sm text-muted-foreground">{hint}</div>}
        </ItemGroup>
        {reg.lerr && <pre className="gerr">{reg.lerr}</pre>}
      </div>
    </div>
  );
}
