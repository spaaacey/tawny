import { useEffect, useLayoutEffect } from 'react';
import type { Leaf } from '../../legacy/layoutStore';
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
        <input
          className="lq"
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
        <div className="lopts">
          {reg.litems.map((it, i) => (
            <div
              key={i}
              className={`lopt qi${i === reg.lsel ? ' sel' : ''}`}
              data-i={i}
              onMouseDown={(e) => {
                e.preventDefault();
                markFocused(g.id);
                runLaunch(g, i);
              }}
            >
              {it.node}
            </div>
          ))}
          {hint && <div className="lopt qi muted">{hint}</div>}
        </div>
        {reg.lerr && <pre className="gerr">{reg.lerr}</pre>}
      </div>
    </div>
  );
}
