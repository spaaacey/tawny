import { useLayoutEffect, useRef, useState } from 'react';
import { activate, focusTerm } from '../lib/actions';
import { attentionItems, workspaceLabel } from '../lib/selectors';
import { useStore } from '../store';
import { SessionIndicator } from './Indicator';
import { revealAgent } from './workspace/layoutStore';
import { agentLabel } from './workspace/panes';

/** Titlebar chips for agents that need you: waiting on input, or finished while unread. */
export function AttentionChips() {
  const app = useStore((s) => s.app);
  const unread = useStore((s) => s.unread);
  const focusedSession = useStore((s) => s.focusedSession);
  const [open, setOpen] = useState(false);
  const [fit, setFit] = useState(Infinity);
  const box = useRef<HTMLDivElement>(null);

  const items = attentionItems(app, unread, focusedSession);

  // chips hide from the end until they fit beside the "+N" button; each is ~180px at most
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setFit(Math.max(1, Math.floor((el.clientWidth - 48) / 188)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = async (w: (typeof items)[number]) => {
    setOpen(false);
    await activate(w.w.path);
    revealAgent(w.s.id);
    focusTerm(w.s.id);
  };
  const chip = (it: (typeof items)[number]) => (
    <button
      key={it.s.id}
      type="button"
      className="att-chip no-drag"
      title={`${workspaceLabel(it.w)} / ${agentLabel(it.s) as string}`}
      onClick={() => go(it)}
    >
      <SessionIndicator s={it.s} />
      <span className="att-ws">{workspaceLabel(it.w)}</span>
      <span className="att-name">{agentLabel(it.s) as string}</span>
    </button>
  );
  const shown = items.slice(0, Math.min(fit, items.length));
  const rest = items.slice(shown.length);

  return (
    <div className="att-bar" ref={box}>
      {shown.map(chip)}
      {rest.length > 0 && (
        <div className="att-more no-drag">
          <button type="button" className="att-chip" onClick={() => setOpen((o) => !o)}>
            +{rest.length}
          </button>
          {open && <div className="att-menu">{rest.map(chip)}</div>}
        </div>
      )}
    </div>
  );
}
