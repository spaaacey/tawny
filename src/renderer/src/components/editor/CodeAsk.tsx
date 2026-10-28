// Message box in a view zone just below the selection's last line: the code below is pushed down rather than covered,
// so all of it stays visible. Opened by host.openAsk (via sendSelectionToAgent). Cmd+enter sends, escape closes,
// shift+tab cycles agents.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { askAgent } from '../../lib/actions';
import { askZone, cycleAsk, hideAsk, selectionRef, useAsk } from './host';

export function CodeAsk({ gid }: { gid: string }) {
  const st = useAsk((s) => s.byGid[gid]);
  const ed = st?.ed;
  const zoneDom = askZone(gid);
  const shown = !!st;
  const domRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const zone = useRef<{ id: string; z: { heightInPx: number } } | null>(null);
  const agent = st?.agents[st.idx];

  const fit = () => {
    const cur = zone.current;
    const dom = domRef.current;
    if (!ed || !cur || !dom) return;
    cur.z.heightInPx = dom.offsetHeight + 12;
    ed.changeViewZones((a) => a.layoutZone(cur.id));
  };
  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    fit();
  };
  const submit = () => {
    const ta = taRef.current;
    if (!ta || !ed) return;
    const msg = ta.value.trim();
    const ref = selectionRef();
    const id = agent?.id;
    ta.value = '';
    hideAsk(gid);
    ed.focus();
    if (ref) askAgent(ref, msg, id);
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // the zone exists while the box is shown
  const last = st?.last;
  useEffect(() => {
    if (!ed || last === undefined) return;
    const z = { afterLineNumber: last, heightInPx: 110, domNode: zoneDom, suppressMouseDown: true };
    let id = '';
    ed.changeViewZones((a) => {
      id = a.addZone(z);
    });
    zone.current = { id, z };
    ed.revealLineInCenterIfOutsideViewport(last);
    return () => {
      zone.current = null;
      try {
        ed.changeViewZones((a) => a.removeZone(id));
      } catch {
        /* editor already disposed */
      }
    };
  }, [ed, zoneDom, last]);

  // native listeners: Monaco's own handlers sit above this node and must not see these events
  useEffect(() => {
    const dom = domRef.current;
    const ta = taRef.current;
    if (!shown || !dom || !ta || !ed) return;
    const onDown = (e: MouseEvent) => {
      if (e.target !== ta) e.preventDefault(); // keep focus where it is
    };
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        submitRef.current();
      } else if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault();
        cycleAsk(gid);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hideAsk(gid);
        ed.focus();
      }
    };
    const onOut = (e: FocusEvent) => {
      if (!dom.contains(e.relatedTarget as Node | null)) hideAsk(gid);
    };
    dom.addEventListener('mousedown', onDown);
    ta.addEventListener('keydown', onKey);
    ta.addEventListener('focusout', onOut);
    return () => {
      dom.removeEventListener('mousedown', onDown);
      ta.removeEventListener('keydown', onKey);
      ta.removeEventListener('focusout', onOut);
    };
  }, [shown, ed, gid]);

  // the zone is laid out on Monaco's next render
  const tick = st?.focusTick;
  useEffect(() => {
    if (tick === undefined) return;
    const raf = requestAnimationFrame(() => {
      fit();
      taRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [tick]);

  if (!st) return null;
  return createPortal(
    <div className="rich-ask" ref={domRef}>
      <textarea
        ref={taRef}
        rows={2}
        placeholder="Message agent about this selection…"
        spellCheck={false}
        onInput={grow}
      />
      <div className="ask-foot">
        <span className="ask-agent" hidden={!agent} title={st.agents.length > 1 ? 'shift+tab: next agent' : ''}>
          <i className={`sdot${agent?.waiting ? ' wait' : agent?.working ? ' work' : ''}`} />
          <span>{agent?.label}</span>
        </span>
        <button type="button" className="ask-send" onClick={submit}>
          Send <kbd>⌘↵</kbd>
        </button>
      </div>
    </div>,
    zoneDom,
  );
}
