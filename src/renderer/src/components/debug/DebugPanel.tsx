import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button, ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../../ui';
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
  const { state, reason, configs, chosen } = useDbg();
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
      <Button variant="ghost" size="icon" title="Close panel" onClick={() => showPanel(false)}>
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </Button>
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

function Panel() {
  const open = useDbg((s) => s.open);
  const height = useDbg((s) => s.height);
  const pane = useRef<HTMLDivElement>(null);

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

  return (
    <div id="dbgPane" ref={pane} hidden={!open} style={height ? { height } : undefined}>
      <div className="dbg-grip" onMouseDown={grip} />
      <Bar />
      <div className="dbg-body">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={15}>
            <ResizablePanelGroup direction="vertical">
              <ResizablePanel defaultSize={38} minSize={10}>
                <div className="dbg-sec">
                  <div className="dbg-h">Call stack</div>
                  <div className="dbg-stack">
                    <Stack />
                  </div>
                </div>
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize={62} minSize={10}>
                <div className="dbg-sec">
                  <div className="dbg-h">Variables</div>
                  <div className="dbg-vars">
                    <Vars />
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={70} minSize={20}>
            <div className="dbg-main">
              <Output />
              <div className="dbg-in">
                <span>›</span>
                <input placeholder="Evaluate in the selected frame…" spellCheck={false} onKeyDown={onKey} />
              </div>
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
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

export function DebugPanel() {
  const host = document.getElementById('dbgHost');
  return (
    <>
      {host && createPortal(<Panel />, host)}
      <Prompt />
    </>
  );
}
