import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnyWorkspace, ListeningPort, PortsSnapshot, ResourceSample, ResourceUsage } from '../../../shared/types';
import { revealSession, toast } from '../lib/actions';
import { H, Layout } from '../lib/legacy';
import { allWorkspaces, workspaceLabel } from '../lib/selectors';
import { useStore } from '../store';
import { Spinner, StatusDot, Tooltip } from '../ui';
import { Chevron, Chip, Plug, Refresh, X } from './icons';

const HISTORY = 30; // keep in sync with HISTORY in src/main/resources.js

const fmtMem = (b: number) =>
  b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`;
const fmtCpu = (c: number) => `${c.toFixed(1)}%`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** CPU history as a tiny line; scale tops out at 10% so an idle workspace stays flat. */
function Spark({ h }: { h: number[] }) {
  if (!h || h.length < 2) return null;
  const W = 60;
  const T = 16;
  const max = Math.max(10, ...h);
  const pts = h.map(
    (v, i) =>
      `${(W - ((h.length - 1 - i) * W) / (HISTORY - 1)).toFixed(1)},${(T - 1 - (v / max) * (T - 2)).toFixed(1)}`,
  );
  return (
    <svg viewBox={`0 0 ${W} ${T}`} width={W} height={T} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

const Nums = ({ r, extra }: { r: ResourceUsage; extra?: React.ReactNode }) => (
  <>
    <span className="num cpu">{fmtCpu(r.cpu)}</span>
    <span className="num mem">{fmtMem(r.rss)}</span>
    {extra ?? <span />}
  </>
);

const wsName = (w: AnyWorkspace) => [w.repoName, workspaceLabel(w)].filter(Boolean).join(' | ');

function Indicator({ state }: { state: string }) {
  switch (state) {
    case 'term':
      return <span className="tglyph">&gt;_</span>;
    case 'lsp':
      return <span className="tglyph">LS</span>;
    case 'wait':
      return <StatusDot state="waiting" size="sm" />;
    case 'work':
      return <Spinner size="sm" />;
    default:
      return <StatusDot state="idle" size="sm" />;
  }
}

/** Closes the popover on outside mousedown / Escape (ignoring its own toggle button). */
function useDismiss(open: boolean, close: () => void, refs: React.RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (!refs.some((r) => r.current?.contains(e.target as Node))) close();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open, close, refs]);
}

function ResourcePopover({ snap, onRefresh, onClose }: { snap: ResourceSample; onRefresh(): void; onClose(): void }) {
  const app = useStore((s) => s.app);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState<Set<string>>(new Set());
  const byPrefix = useMemo(() => new Map(allWorkspaces(app).map((w) => [w.prefix, w])), [app]);
  const sessions = useMemo(() => new Map(app.sessions.map((s) => [s.id, s])), [app.sessions]);

  const rows = snap.workspaces.map((w) => {
    const wt = byPrefix.get(w.prefix);
    const items = w.sessions.flatMap((r) => {
      if (r.lsp) return [{ ...r, name: r.lsp, state: 'lsp' }];
      const info = sessions.get(r.id); // gone from state: just killed, next sample drops it
      if (!info) return [];
      const state = info.kind === 'terminal' ? 'term' : info.waiting ? 'wait' : info.working ? 'work' : 'idle';
      return [{ ...r, name: Layout().agentLabel(info) as string, state }];
    });
    return { w, name: wt ? wsName(wt) : 'Other sessions', path: wt?.path, items };
  });

  const toggle = (prefix: string) =>
    setFolded((f) => {
      const n = new Set(f);
      if (!n.delete(prefix)) n.add(prefix);
      return n;
    });

  const kill = async (id: string) => {
    setGone((g) => new Set(g).add(id));
    try {
      await H.killAgent(id);
    } catch (e) {
      setGone((g) => {
        const n = new Set(g);
        n.delete(id);
        return n;
      });
      toast(errMsg(e));
    }
  };

  return (
    <div className="popover">
      <div className="res-head">
        <span>Resource Manager</span>
        <button type="button" className="icon-btn" title="Refresh" onClick={onRefresh}>
          <Refresh />
        </button>
      </div>
      <div className="res-total">{`${fmtCpu(snap.cpu)} · ${fmtMem(snap.rss)} Σ Memory`}</div>
      <div className="rr res-cols">
        <span>Name</span>
        <span />
        <span className="num">CPU</span>
        <span className="num">Memory</span>
        <span />
      </div>
      <div className="res-list">
        {rows.length === 0 && <div className="res-empty">No running sessions</div>}
        {rows.map(({ w, name, path, items }) => (
          <div key={w.prefix} className={`rw ${folded.has(w.prefix) ? 'collapsed' : ''}`}>
            <div className="rr rw-head" onClick={() => toggle(w.prefix)}>
              <span className="rr-name">
                <span className="rr-chev">
                  <Chevron />
                </span>
                <span className="rr-label">{name}</span>
              </span>
              <span className="spark">
                <Spark h={w.history} />
              </span>
              <Nums r={w} />
            </div>
            {items.map((r) => (
              <div
                key={r.id}
                className={`rr rr-tab ${r.lsp ? 'lsp' : ''}${gone.has(r.id) ? ' gone' : ''}`}
                onClick={() => {
                  if (r.lsp || !path) return;
                  onClose();
                  revealSession(path, r.id);
                }}
              >
                <span className="rr-name">
                  <span className="ind">
                    <Indicator state={r.state} />
                  </span>
                  <span className="rr-label">{r.name}</span>
                </span>
                <span />
                <Nums
                  r={r}
                  extra={
                    r.lsp ? undefined : (
                      <button
                        type="button"
                        className="icon-btn danger rr-kill"
                        title="Stop (kills this session)"
                        onClick={(e) => {
                          e.stopPropagation();
                          kill(r.id);
                        }}
                      >
                        <X />
                      </button>
                    )
                  }
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="rr res-app">
        <span className="rr-name">
          <span className="ind" />
          <span className="rr-label">Tawny</span>
        </span>
        <span />
        <span className="res-app-nums">
          <Nums r={snap.app} />
        </span>
      </div>
    </div>
  );
}

function PortRow({ p, onKilled }: { p: ListeningPort; onKilled(): void }) {
  const [gone, setGone] = useState(false);
  return (
    <div className={`pr${gone ? ' gone' : ''}`}>
      <span className="pr-port">{p.port}</span>
      <span className="pr-info">
        <span className="pr-cmd">{p.command}</span>
        <span className="pr-addr">{p.addr}</span>
      </span>
      <button
        type="button"
        className="icon-btn danger pr-kill"
        title={`Kill ${p.command} (pid ${p.pid})`}
        onClick={async () => {
          setGone(true);
          try {
            await H.killPort(p.pid, p.port);
            setTimeout(onKilled, 500);
          } catch (e) {
            setGone(false);
            toast(errMsg(e));
          }
        }}
      >
        <X />
      </button>
    </div>
  );
}

function PortsPopover({ snap, onRefresh }: { snap: PortsSnapshot; onRefresh(): void }) {
  const app = useStore((s) => s.app);
  const [externalOpen, setExternalOpen] = useState(false);
  const byPrefix = useMemo(() => new Map(allWorkspaces(app).map((w) => [w.prefix, w])), [app]);
  const nExt = snap.external.length;
  return (
    <div className="popover">
      <div className="res-head">
        <span className="port-title">
          <span className="sb-icon">
            <Plug />
          </span>
          Ports
        </span>
        <span className="port-summary">{`${plural(snap.workspaces.length, 'workspace')} · ${nExt} external`}</span>
      </div>
      <div className="port-list">
        {snap.workspaces.map((w) => {
          const wt = byPrefix.get(w.prefix);
          return (
            <div key={w.prefix} className="pw">
              <div className="pw-head">
                <span className="rr-label">{wt ? wsName(wt) : 'Other sessions'}</span>
                <span className="pw-count">{w.ports.length}</span>
              </div>
              {w.ports.map((p) => (
                <PortRow key={`${p.pid}:${p.port}`} p={p} onKilled={onRefresh} />
              ))}
            </div>
          );
        })}
        {nExt > 0 && (
          <div className={`pw ext ${externalOpen ? '' : 'collapsed'}`}>
            <div className="pw-head ext-head" onClick={() => setExternalOpen((o) => !o)}>
              <span className="rr-chev">
                <Chevron />
              </span>
              <span className="rr-label">External ports</span>
              <span className="pw-count">{nExt}</span>
            </div>
            {snap.external.map((p) => (
              <PortRow key={`${p.pid}:${p.port}`} p={p} onKilled={onRefresh} />
            ))}
          </div>
        )}
        {!snap.workspaces.length && !nExt && <div className="res-empty">No listening ports</div>}
      </div>
    </div>
  );
}

export function StatusBar() {
  const popover = useStore((s) => s.popover);
  const setPopover = useStore((s) => s.setPopover);
  const sessionCount = useStore((s) => s.app.sessions.length);
  const [res, setRes] = useState<ResourceSample | null>(null);
  const [ports, setPorts] = useState<PortsSnapshot | null>(null);
  const resBtn = useRef<HTMLButtonElement>(null);
  const portBtn = useRef<HTMLButtonElement>(null);
  const resPop = useRef<HTMLDivElement>(null);
  const portPop = useRef<HTMLDivElement>(null);

  const refreshRes = useCallback(() => H.resources().then(setRes, () => {}), []);
  const refreshPorts = useCallback(() => H.ports().then(setPorts, () => {}), []);

  useEffect(() => {
    refreshRes();
    refreshPorts();
    const a = H.onResources(setRes);
    const b = H.onPorts(setPorts);
    return () => {
      a();
      b();
    };
  }, [refreshRes, refreshPorts]);
  useEffect(() => {
    if (popover === 'resources') refreshRes();
    if (popover === 'ports') refreshPorts();
  }, [popover, refreshRes, refreshPorts]);

  const close = useCallback(() => setPopover(null), [setPopover]);
  const resRefs = useMemo(() => [resPop, resBtn], []);
  const portRefs = useMemo(() => [portPop, portBtn], []);
  useDismiss(popover === 'resources', close, resRefs);
  useDismiss(popover === 'ports', close, portRefs);

  const nWs = ports?.workspaces.reduce((a, w) => a + w.ports.length, 0) ?? 0;
  const nExt = ports?.external.length ?? 0;

  return (
    <>
      <footer id="statusBar">
        <div className="sb-side" />
        <div className="sb-side">
          <Tooltip content={`Ports — ${plural(nWs, 'workspace port')}, ${nExt} external`}>
            <button
              type="button"
              ref={portBtn}
              id="portBtn"
              className={`sb-item${popover === 'ports' ? ' on' : ''}`}
              aria-expanded={popover === 'ports'}
              onClick={() => setPopover(popover === 'ports' ? null : 'ports')}
            >
              <span className="sb-icon">
                <Plug />
              </span>
              <span className="sb-count">{nWs}</span>
            </button>
          </Tooltip>
          <Tooltip content="Resource Manager">
            <button
              type="button"
              ref={resBtn}
              id="resBtn"
              className={`sb-item${popover === 'resources' ? ' on' : ''}`}
              aria-expanded={popover === 'resources'}
              onClick={() => setPopover(popover === 'resources' ? null : 'resources')}
            >
              <span className="sb-icon">
                <Chip />
              </span>
              <span className="sb-text">{res ? `${fmtMem(res.rss)} · ${fmtCpu(res.cpu)}` : '…'}</span>
              <span className="sb-sep">·</span>
              <span className="tglyph">&gt;_</span>
              <span className="sb-count">{sessionCount}</span>
            </button>
          </Tooltip>
        </div>
      </footer>
      {popover === 'resources' && res && (
        <div ref={resPop} style={{ display: 'contents' }}>
          <ResourcePopover snap={res} onRefresh={refreshRes} onClose={close} />
        </div>
      )}
      {popover === 'ports' && ports && (
        <div ref={portPop} style={{ display: 'contents' }}>
          <PortsPopover snap={ports} onRefresh={refreshPorts} />
        </div>
      )}
    </>
  );
}
