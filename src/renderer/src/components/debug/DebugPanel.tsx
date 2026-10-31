import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../ui/resizable';
import { usePrompt } from './breakpoints';
import {
  clearConsole,
  cont,
  historyStep,
  loadConfigs,
  pause,
  type Scope,
  selectFrame,
  setChosen,
  setDock,
  setHeight,
  showPanel,
  start,
  step,
  stop,
  submitExpr,
  toggleVar,
  useDbg,
  type Variable,
} from './session';

const svg = (d: ReactNode, size = 14) => (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {d}
  </svg>
);

const BTN: Record<string, { icon: ReactNode; title: string; cls: string; run: () => void }> = {
  start: { icon: '▶', title: 'Start debugging (F5)', cls: 'text-[var(--idle)]', run: start },
  cont: { icon: '▶', title: 'Continue (F5)', cls: 'text-[var(--idle)]', run: cont },
  pause: { icon: '⏸', title: 'Pause', cls: '', run: pause },
  next: {
    icon: svg(
      <>
        <path d="M2.5 9.5a5.5 5.5 0 0 1 11 0" />
        <path d="M11 7.5l2.5 2-2.5 2" />
        <circle cx="8" cy="12.5" r="1" fill="currentColor" />
      </>,
    ),
    title: 'Step over (F10)',
    cls: '',
    run: () => step('next'),
  },
  in: {
    icon: svg(
      <>
        <path d="M8 2v8M5 7.5L8 10.5l3-3" />
        <circle cx="8" cy="13" r="1" fill="currentColor" />
      </>,
    ),
    title: 'Step into (F11)',
    cls: '',
    run: () => step('stepIn'),
  },
  out: {
    icon: svg(
      <>
        <path d="M8 10V2M5 4.5L8 1.5l3 3" />
        <circle cx="8" cy="13" r="1" fill="currentColor" />
      </>,
    ),
    title: 'Step out (⇧F11)',
    cls: '',
    run: () => step('stepOut'),
  },
  stop: { icon: '■', title: 'Stop (⇧F5)', cls: 'text-[var(--danger)]', run: stop },
};

const base = (p: string) => p.split('/').pop() || p;

function Bar() {
  const { state, reason, configs, chosen, dock } = useDbg();
  const idle = state === 'ended';
  const items = idle
    ? ['start']
    : state === 'stopped'
      ? ['cont', 'next', 'in', 'out', 'stop']
      : state === 'running'
        ? ['pause', 'stop']
        : ['stop'];
  const label = idle
    ? ''
    : state === 'starting'
      ? 'Starting…'
      : state === 'running'
        ? 'Running'
        : `Paused${reason ? ` (${reason})` : ''}`;
  return (
    <div className="dbg-bar">
      <select
        id="dbgConfig"
        title="Launch configuration"
        value={chosen || ''}
        disabled={!idle || !configs.length}
        onChange={(e) => setChosen(e.target.value)}
        onMouseDown={() => loadConfigs()}
      >
        {configs.length ? (
          configs.map((c) => <option key={c.name}>{c.name}</option>)
        ) : (
          <option>No configuration</option>
        )}
      </select>
      <span className="flex gap-0.5">
        {items.map((k) => (
          <Button
            key={k}
            variant="ghost"
            size="icon"
            title={BTN[k].title}
            disabled={k === 'start' && !configs.length}
            onClick={BTN[k].run}
          >
            <span className={BTN[k].cls}>{BTN[k].icon}</span>
          </Button>
        ))}
      </span>
      <span className={`dbg-state ${state}`}>{label}</span>
      <span className="dbg-sp" />
      <Button variant="ghost" size="icon" title="Clear console" onClick={clearConsole}>
        {svg(
          <>
            <circle cx="8" cy="8" r="5.5" />
            <path d="M4.2 11.8l7.6-7.6" />
          </>,
          13,
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title={dock === 'side' ? 'Move to bottom panel' : 'Move to secondary sidebar'}
        onClick={() => setDock(dock === 'side' ? 'bottom' : 'side')}
      >
        {dock === 'side'
          ? svg(
              <>
                <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                <path d="M2 9.5h12" />
              </>,
              13,
            )
          : svg(
              <>
                <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
                <path d="M9.5 2.5v11" />
              </>,
              13,
            )}
      </Button>
      {dock === 'bottom' && (
        <Button variant="ghost" size="icon" title="Close panel" onClick={() => showPanel(false)}>
          <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </Button>
      )}
    </div>
  );
}

function Stack() {
  const { state, frames, frameIdx } = useDbg();
  if (state !== 'stopped' || !frames.length)
    return (
      <div className="dbg-none">
        {state === 'running' ? 'Running' : state === 'starting' ? 'Starting…' : 'Not paused'}
      </div>
    );
  return (
    <>
      {frames.map((f, i) => {
        if (f.presentationHint === 'label')
          return (
            <div key={f.id} className="dbg-lbl">
              {f.name}
            </div>
          );
        const p = f.source?.path;
        const where = p ? `${base(p)}:${f.line}` : f.source?.name || '';
        return (
          <div
            key={f.id}
            className={`dbg-fr ${i === frameIdx ? 'sel' : ''} ${f.presentationHint === 'subtle' || !p ? 'dim' : ''}`}
            title={p || ''}
            onClick={() => selectFrame(i)}
          >
            <span className="n">{f.name}</span>
            <span className="w">{where}</span>
          </div>
        );
      })}
    </>
  );
}

function VarRow({
  name,
  value,
  hasKids,
  vkey,
  vref,
  scope,
}: {
  name: string;
  value?: string;
  hasKids: boolean;
  vkey: string;
  vref: number;
  scope?: boolean;
}) {
  const open = useDbg((s) => s.openVars.has(vkey));
  const kids = useDbg((s) => s.kids[vkey]);
  const val = String(value ?? '');
  return (
    <div className={scope ? 'dbg-scope' : 'dbg-var'} data-key={vkey}>
      <div className={`dbg-v ${scope ? 'scope' : ''}`} onClick={() => vref && toggleVar(vkey, vref)}>
        <span className="tw">{hasKids ? (open ? '▾' : '▸') : ''}</span>
        <span className="k">{name}</span>
        {!scope && <span className="sepr">:</span>}
        {!scope && (
          <span className="val" title={val.slice(0, 600)}>
            {val.length > 240 ? `${val.slice(0, 240)}…` : val}
          </span>
        )}
      </div>
      {open && kids && (
        <div className="kids">
          {kids.loading && <div className="dbg-none">…</div>}
          {kids.error && <div className="dbg-none">{kids.error}</div>}
          {kids.vars?.map((v: Variable) => (
            <VarRow
              key={v.name}
              name={v.name}
              value={v.value}
              hasKids={(v.variablesReference || 0) > 0}
              vkey={`${vkey}/${v.name}`}
              vref={v.variablesReference || 0}
            />
          ))}
          {kids.vars && !kids.vars.length && <div className="dbg-none">empty</div>}
        </div>
      )}
    </div>
  );
}

function Vars() {
  const { state, scopes, scopeError } = useDbg();
  if (scopeError) return <div className="dbg-none">{scopeError}</div>;
  if (state !== 'stopped' || !scopes.length) return <div className="dbg-none">—</div>;
  return (
    <>
      {scopes.map((s: Scope) => (
        <VarRow key={s.name} scope name={s.name} hasKids vkey={s.name} vref={s.variablesReference} />
      ))}
    </>
  );
}

function Output() {
  const lines = useDbg((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const near = useRef(true);
  // measured before React commits the new lines, so "near the bottom" refers to what the user was looking at
  if (ref.current) near.current = ref.current.scrollHeight - ref.current.scrollTop - ref.current.clientHeight < 40;
  useEffect(() => {
    if (ref.current && near.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <div className="dbg-out" ref={ref}>
      {lines.map((l) => (
        <div key={l.id} className={`dbg-ln ${l.cls}`}>
          {l.text}
        </div>
      ))}
    </div>
  );
}

export function DebugView({ dock }: { dock: 'side' | 'bottom' }) {
  const open = useDbg((s) => s.open);
  const height = useDbg((s) => s.height);
  const pane = useRef<HTMLDivElement>(null);
  const bottom = dock === 'bottom';

  const grip = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = pane.current as HTMLDivElement;
    const sy = e.clientY;
    const sh = el.getBoundingClientRect().height;
    const mv = (ev: MouseEvent) => {
      el.style.height = `${Math.max(120, Math.min(window.innerHeight - 200, sh + sy - ev.clientY))}px`;
    };
    const up = () => {
      removeEventListener('mousemove', mv);
      removeEventListener('mouseup', up);
      setHeight(el.style.height);
    };
    addEventListener('mousemove', mv);
    addEventListener('mouseup', up);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const input = e.currentTarget;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      input.value = historyStep(e.key === 'ArrowUp' ? -1 : 1);
      e.preventDefault();
    } else if (e.key === 'Enter' && input.value.trim()) {
      const expr = input.value.trim();
      input.value = '';
      submitExpr(expr);
    }
  };

  const stack = (
    <div className="dbg-sec">
      <div className="dbg-h">Call stack</div>
      <div className="dbg-stack">
        <Stack />
      </div>
    </div>
  );
  const vars = (
    <div className="dbg-sec">
      <div className="dbg-h">Variables</div>
      <div className="dbg-vars">
        <Vars />
      </div>
    </div>
  );
  const main = (
    <div className="dbg-main">
      <Output />
      <div className="dbg-in">
        <span>›</span>
        <input placeholder="Evaluate in the selected frame…" spellCheck={false} onKeyDown={onKey} />
      </div>
    </div>
  );

  return (
    <div
      id="dbgPane"
      ref={pane}
      className={bottom ? 'bottom' : ''}
      hidden={bottom && !open}
      style={bottom && height ? { height } : undefined}
    >
      {bottom && <div className="dbg-grip" onMouseDown={grip} />}
      <Bar />
      <div className="dbg-body">
        {bottom ? (
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel defaultSize="30%" minSize="15%">
              <ResizablePanelGroup orientation="vertical">
                <ResizablePanel defaultSize="38%" minSize="10%">
                  {stack}
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel defaultSize="62%" minSize="10%">
                  {vars}
                </ResizablePanel>
              </ResizablePanelGroup>
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="70%" minSize="20%">
              {main}
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <ResizablePanelGroup orientation="vertical">
            <ResizablePanel defaultSize="25%" minSize="8%">
              {stack}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="35%" minSize="8%">
              {vars}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel defaultSize="40%" minSize="10%">
              {main}
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </div>
  );
}

/** Breakpoint condition / logpoint prompt */
function Prompt() {
  const p = usePrompt((s) => s.prompt);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p) {
      input.current?.focus();
      input.current?.select();
    }
  }, [p]);
  if (!p) return null;
  return (
    <div
      id="dbgPromptBack"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) p.done(null);
      }}
    >
      <div className="quick">
        <input
          id="dbgPromptInput"
          ref={input}
          spellCheck={false}
          placeholder={p.placeholder}
          defaultValue={p.initial}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              p.done(e.currentTarget.value);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              p.done(null);
            }
            e.stopPropagation();
          }}
        />
      </div>
    </div>
  );
}

/** Prompt, plus the bottom-docked panel (the sidebar one is rendered by TreePane). */
export function DebugPanel() {
  const host = document.getElementById('dbgHost');
  const dock = useDbg((s) => s.dock);
  return (
    <>
      {host && dock === 'bottom' && createPortal(<DebugView dock="bottom" />, host)}
      <Prompt />
    </>
  );
}
