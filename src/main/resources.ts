// CPU and memory per workspace: sums the process tree under each agent/terminal session (plus the
// workspace's language servers), and Tawny's own Electron processes.

import type { ListeningPort, ResourceSample } from '../shared/types';
import type { Agents } from './agents';
import * as G from './git';
import type { Lsp } from './lsp';

const HISTORY = 30; // CPU samples kept per workspace (sparkline)
const MIN_GAP_MS = 500; // sample() inside this window returns the last snapshot

/** `ps -o time` is [[dd-]hh:]mm:ss(.cc) */
function cpuSeconds(t: string) {
  const [d, rest] = t.includes('-') ? t.split('-') : ['0', t];
  return rest.split(':').reduce((a, p) => a * 60 + parseFloat(p), 0) + Number(d) * 86400;
}

interface Proc {
  ppid: number;
  rss: number;
  cpu: number;
}
interface Row {
  id: string;
  lsp?: string;
  cpu: number;
  rss: number;
}
interface Group {
  prefix: string;
  cpu: number;
  rss: number;
  sessions: Row[];
  history?: number[];
}
type Sample = Omit<ResourceSample, 'workspaces'> & { at: number; workspaces: Group[] };
type Metric = { cpu: { percentCPUUsage: number }; memory: { workingSetSize: number } };

class Resources {
  prev = new Map<number, number>(); // pid -> cumulative cpu seconds at the last sample
  prevAt = 0;
  history = new Map<string, number[]>(); // workspace prefix -> [cpu%]
  last: Sample | null = null;
  running: Promise<Sample> | null = null;
  agents: Agents;
  lsp: Lsp;
  worktrees: () => { path: string; prefix: string }[];
  appMetrics: () => Metric[];

  /** `agents`, `lsp`: the main-process singletons; `worktrees()`: [{path, prefix}]; `appMetrics()`: Electron's getAppMetrics. */
  constructor({ agents, lsp, worktrees, appMetrics }: Pick<Resources, 'agents' | 'lsp' | 'worktrees' | 'appMetrics'>) {
    this.agents = agents;
    this.lsp = lsp;
    this.worktrees = worktrees;
    this.appMetrics = appMetrics;
  }

  /** pid -> {ppid, rss (bytes), cpu (cumulative seconds)} for every process. */
  async processes() {
    const out = await G.run('ps', ['-axo', 'pid=,ppid=,rss=,time=']);
    const procs = new Map<number, Proc>();
    for (const line of out.split('\n')) {
      const [pid, ppid, rss, time] = line.trim().split(/\s+/);
      if (time) procs.set(+pid, { ppid: +ppid, rss: +rss * 1024, cpu: cpuSeconds(time) });
    }
    return procs;
  }

  /** Root pid of each session: the pty's shell (chat tabs: the adapter process). */
  async sessionPids() {
    const pids = new Map<string, number>();
    for (const s of this.agents.sessions.values()) if (s.pty) pids.set(s.id, s.pty.pid);
    for (const s of this.agents.sessions.values()) if (s.acp?.pid) pids.set(s.id, s.acp.pid); // chat tabs: the adapter process
    return pids;
  }

  /** Listening TCP sockets as [{pid, command, addr, port}], one per pid+port. */
  async listeners(): Promise<ListeningPort[]> {
    let out: string;
    try {
      out = await G.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
    } catch {
      return [];
    } // lsof exits 1 when nothing listens
    const seen = new Map<string, ListeningPort>();
    let pid = 0,
      command = '';
    for (const line of out.split('\n')) {
      const v = line.slice(1);
      if (line[0] === 'p') pid = +v;
      else if (line[0] === 'c') command = v;
      else if (line[0] === 'n') {
        const i = v.lastIndexOf(':');
        const port = +v.slice(i + 1);
        if (i > 0 && port) seen.set(`${pid}:${port}`, { pid, command, addr: v, port });
      }
    }
    return [...seen.values()];
  }

  /** SIGTERM the process listening on a port. Re-checks the pid still owns it, so a stale row can't hit a recycled pid. */
  async killPort(pid: number, port: number) {
    if (!(await this.listeners()).some((l) => l.pid === pid && l.port === port))
      throw new Error(`Nothing listening on :${port} any more`);
    process.kill(pid, 'SIGTERM');
  }

  /** Listening ports split into those owned by a workspace's sessions/language servers (by process ancestry) and the rest. */
  async ports() {
    if (process.platform === 'win32') return { at: Date.now(), workspaces: [], external: [] };
    const [procs, sessionPids, listeners] = await Promise.all([this.processes(), this.sessionPids(), this.listeners()]);
    const roots = new Map<number, string>(); // root pid -> workspace prefix
    for (const s of this.agents.sessions.values()) {
      const pid = sessionPids.get(s.id);
      if (pid) roots.set(pid, s.prefix);
    }
    const prefixOfRoot = new Map(this.worktrees().map((w) => [w.path, w.prefix] as const));
    for (const srv of this.lsp.servers.values()) {
      const pid = srv.proc && srv.proc.pid,
        prefix = prefixOfRoot.get(srv.root);
      if (pid && prefix) roots.set(pid, prefix);
    }
    const ownerOf = (start: number) => {
      let pid = start;
      for (let n = 0; pid > 1 && n < 64; n++) {
        const p = procs.get(pid);
        if (!p) break;
        const prefix = roots.get(pid);
        if (prefix !== undefined) return prefix;
        pid = p.ppid;
      }
      return null;
    };
    const byPrefix = new Map<string, ListeningPort[]>(),
      external: ListeningPort[] = [];
    for (const l of listeners.sort((a, b) => a.port - b.port)) {
      const prefix = ownerOf(l.pid);
      if (prefix === null) external.push(l);
      else (byPrefix.get(prefix) || byPrefix.set(prefix, []).get(prefix)!).push(l);
    }
    return { at: Date.now(), workspaces: [...byPrefix].map(([prefix, ports]) => ({ prefix, ports })), external };
  }

  sample() {
    if (this.last && Date.now() - this.last.at < MIN_GAP_MS) return Promise.resolve(this.last);
    if (!this.running)
      this.running = this.measure().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async measure() {
    if (process.platform === 'win32')
      return (this.last = { at: Date.now(), cpu: 0, rss: 0, app: { cpu: 0, rss: 0 }, workspaces: [] });
    const [procs, sessionPids] = await Promise.all([this.processes(), this.sessionPids()]);
    const now = Date.now(),
      dt = (now - this.prevAt) / 1000;

    const kids = new Map<number, number[]>();
    for (const [pid, p] of procs) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)!).push(pid);
    const cpuOf = (pid: number) => {
      // % of one core since the previous sample; a process we haven't seen has no baseline yet
      const before = this.prev.get(pid);
      return before === undefined || !this.prevAt ? 0 : (Math.max(0, (procs.get(pid)?.cpu ?? 0) - before) / dt) * 100;
    };
    const tree = (root: number) => {
      const sum = { cpu: 0, rss: 0 };
      if (!procs.has(root)) return sum;
      for (const stack = [root]; stack.length; ) {
        const pid = stack.pop() as number;
        sum.cpu += cpuOf(pid);
        sum.rss += procs.get(pid)?.rss ?? 0;
        stack.push(...(kids.get(pid) || []));
      }
      return sum;
    };

    const byPrefix = new Map<string, Group>();
    const group = (prefix: string): Group =>
      byPrefix.get(prefix) || byPrefix.set(prefix, { prefix, cpu: 0, rss: 0, sessions: [] }).get(prefix)!;
    for (const s of this.agents.sessions.values()) {
      const pid = sessionPids.get(s.id);
      if (!pid) continue;
      const r = tree(pid),
        g = group(s.prefix);
      g.sessions.push({ id: s.id, ...r });
    }
    const prefixOfRoot = new Map(this.worktrees().map((w) => [w.path, w.prefix] as const));
    for (const srv of this.lsp.servers.values()) {
      const pid = srv.proc && srv.proc.pid,
        prefix = prefixOfRoot.get(srv.root);
      if (!pid || !prefix) continue;
      group(prefix).sessions.push({ id: `lsp:${srv.kind}`, lsp: srv.spec.name || srv.kind, ...tree(pid) });
    }
    for (const g of byPrefix.values()) {
      for (const s of g.sessions) {
        g.cpu += s.cpu;
        g.rss += s.rss;
      }
      g.sessions.sort((a, b) => b.rss - a.rss);
      const h = this.history.get(g.prefix) || [];
      h.push(g.cpu);
      this.history.set(g.prefix, h.slice(-HISTORY));
      g.history = this.history.get(g.prefix);
    }
    for (const k of this.history.keys()) if (!byPrefix.has(k)) this.history.delete(k);

    const app = { cpu: 0, rss: 0 };
    for (const m of this.appMetrics()) {
      app.cpu += m.cpu.percentCPUUsage;
      app.rss += m.memory.workingSetSize * 1024;
    }
    const workspaces = [...byPrefix.values()].sort((a, b) => b.rss - a.rss);

    this.prev = new Map([...procs].map(([pid, p]) => [pid, p.cpu]));
    this.prevAt = now;
    return (this.last = {
      at: now,
      cpu: app.cpu + workspaces.reduce((a, w) => a + w.cpu, 0),
      rss: app.rss + workspaces.reduce((a, w) => a + w.rss, 0),
      app,
      workspaces,
    });
  }
}

export { Resources };
