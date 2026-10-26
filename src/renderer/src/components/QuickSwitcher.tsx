import { useEffect, useMemo, useRef, useState } from 'react';
import { activate } from '../lib/actions';
import { allWorkspaces, sessionsFor, workspaceLabel } from '../lib/selectors';
import { useStore } from '../store';
import { Indicator } from './Indicator';
import { Backdrop } from './Overlay';

export function QuickSwitcher() {
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
    <Backdrop>
      <div className="quick">
        <input
          className="quick-input"
          ref={input}
          placeholder="Switch to worktree…"
          spellCheck={false}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              setSel(Math.min(items.length - 1, cur + 1));
              e.preventDefault();
            } else if (e.key === 'ArrowUp') {
              setSel(Math.max(0, cur - 1));
              e.preventDefault();
            } else if (e.key === 'Enter') pick(cur);
            else if (e.key === 'Escape') close();
          }}
        />
        <div className="qlist">
          {items.map((w, i) => {
            const ss = sessionsFor(app, w);
            return (
              <div key={w.path} className={`qi ${i === cur ? 'sel' : ''}`} onClick={() => pick(i)}>
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
            );
          })}
          {!items.length && (
            <div className="qi" style={{ color: 'var(--faint)' }}>
              No matches
            </div>
          )}
        </div>
      </div>
    </Backdrop>
  );
}
