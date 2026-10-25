'use strict';
// CPU and memory per workspace: sums the process tree under each agent/terminal session (plus the
// workspace's language servers), and Tawny's own Electron processes.
const G = require('./git');

const HISTORY = 30;      // CPU samples kept per workspace (sparkline)
const MIN_GAP_MS = 500;  // sample() inside this window returns the last snapshot

/** `ps -o time` is [[dd-]hh:]mm:ss(.cc) */
function cpuSeconds(t) {
  const [d, rest] = t.includes('-') ? t.split('-') : [0, t];
  return rest.split(':').reduce((a, p) => a * 60 + parseFloat(p), 0) + Number(d) * 86400;
}

class Resources {
  /** `agents`, `lsp`: the main-process singletons; `worktrees()`: [{path, prefix}]; `appMetrics()`: Electron's getAppMetrics. */
  constructor({ agents, lsp, worktrees, appMetrics }) {
    this.agents = agents;
    this.lsp = lsp;
    this.worktrees = worktrees;
    this.appMetrics = appMetrics;
    this.prev = new Map();     // pid -> cumulative cpu seconds at the last sample
    this.prevAt = 0;
    this.history = new Map();  // workspace prefix -> [cpu%]
    this.last = null;
    this.running = null;
  }

  /** pid -> {ppid, rss (bytes), cpu (cumulative seconds)} for every process. */
  async processes() {
    const out = await G.run('ps', ['-axo', 'pid=,ppid=,rss=,time=']);
    const procs = new Map();
    for (const line of out.split('\n')) {
      const [pid, ppid, rss, time] = line.trim().split(/\s+/);
      if (time) procs.set(+pid, { ppid: +ppid, rss: +rss * 1024, cpu: cpuSeconds(time) });
    }
    return procs;
  }

  /** Root pid of each session: the pane's shell under tmux (our pty is only the tmux client), else the pty's shell. */
  async sessionPids() {
    const pids = new Map();
    if (this.agents.tmux) {
      try {
        const out = await G.run('tmux', ['list-panes', '-a', '-F', '#{session_name}|#{pane_pid}']);
        for (const line of out.split('\n')) {
          const i = line.lastIndexOf('|');
          if (i > 0) pids.set(line.slice(0, i), +line.slice(i + 1));
        }
      } catch { /* no tmux server */ }
    }
    for (const s of this.agents.sessions.values()) if (!pids.has(s.id) && s.pty) pids.set(s.id, s.pty.pid);
    return pids;
  }

  /** Listening TCP sockets as [{pid, command, addr, port}], one per pid+port. */
  async listeners() {
    let out;
    try { out = await G.run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']); } catch { return []; }   // lsof exits 1 when nothing listens
    const seen = new Map();
    let pid = 0, command = '';
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
  async killPort(pid, port) {
    if (!(await this.listeners()).some(l => l.pid === pid && l.port === port)) throw new Error(`Nothing listening on :${port} any more`);
    process.kill(pid, 'SIGTERM');
  }

  /** Listening ports split into those owned by a workspace's sessions/language servers (by process ancestry) and the rest. */
  async ports() {
    if (process.platform === 'win32') return { at: Date.now(), workspaces: [], external: [] };
    const [procs, sessionPids, listeners] = await Promise.all([this.processes(), this.sessionPids(), this.listeners()]);
    const roots = new Map();   // root pid -> workspace prefix
    for (const s of this.agents.sessions.values()) if (sessionPids.has(s.id)) roots.set(sessionPids.get(s.id), s.prefix);
    const prefixOfRoot = new Map(this.worktrees().map(w => [w.path, w.prefix]));
    for (const srv of this.lsp.servers.values()) {
      const pid = srv.proc && srv.proc.pid, prefix = prefixOfRoot.get(srv.root);
      if (pid && prefix) roots.set(pid, prefix);
    }
    const ownerOf = pid => {
      for (let n = 0; pid > 1 && procs.has(pid) && n < 64; n++, pid = procs.get(pid).ppid) if (roots.has(pid)) return roots.get(pid);
      return null;
    };
    const byPrefix = new Map(), external = [];
    for (const l of listeners.sort((a, b) => a.port - b.port)) {
      const prefix = ownerOf(l.pid);
      if (prefix === null) external.push(l);
      else (byPrefix.get(prefix) || byPrefix.set(prefix, []).get(prefix)).push(l);
    }
    return { at: Date.now(), workspaces: [...byPrefix].map(([prefix, ports]) => ({ prefix, ports })), external };
  }

  sample() {
    if (this.last && Date.now() - this.last.at < MIN_GAP_MS) return Promise.resolve(this.last);
    if (!this.running) this.running = this.measure().finally(() => { this.running = null; });
    return this.running;
  }

  async measure() {
    if (process.platform === 'win32') return (this.last = { at: Date.now(), cpu: 0, rss: 0, app: { cpu: 0, rss: 0 }, workspaces: [] });
    const [procs, sessionPids] = await Promise.all([this.processes(), this.sessionPids()]);
    const now = Date.now(), dt = (now - this.prevAt) / 1000;

    const kids = new Map();
    for (const [pid, p] of procs) (kids.get(p.ppid) || kids.set(p.ppid, []).get(p.ppid)).push(pid);
    const cpuOf = pid => {   // % of one core since the previous sample; a process we haven't seen has no baseline yet
      const before = this.prev.get(pid);
      return before === undefined || !this.prevAt ? 0 : Math.max(0, procs.get(pid).cpu - before) / dt * 100;
    };
    const tree = root => {
      const sum = { cpu: 0, rss: 0 };
      if (!procs.has(root)) return sum;
      for (const stack = [root]; stack.length;) {
        const pid = stack.pop();
        sum.cpu += cpuOf(pid);
        sum.rss += procs.get(pid).rss;
        stack.push(...(kids.get(pid) || []));
      }
      return sum;
    };

    const byPrefix = new Map();
    const group = prefix => byPrefix.get(prefix) || byPrefix.set(prefix, { prefix, cpu: 0, rss: 0, sessions: [] }).get(prefix);
    for (const s of this.agents.sessions.values()) {
      const pid = sessionPids.get(s.id);
      if (!pid) continue;
      const r = tree(pid), g = group(s.prefix);
      g.sessions.push({ id: s.id, ...r });
    }
    const prefixOfRoot = new Map(this.worktrees().map(w => [w.path, w.prefix]));
    for (const srv of this.lsp.servers.values()) {
      const pid = srv.proc && srv.proc.pid, prefix = prefixOfRoot.get(srv.root);
      if (!pid || !prefix) continue;
      group(prefix).sessions.push({ id: `lsp:${srv.kind}`, lsp: srv.spec.name || srv.kind, ...tree(pid) });
    }
    for (const g of byPrefix.values()) {
      for (const s of g.sessions) { g.cpu += s.cpu; g.rss += s.rss; }
      g.sessions.sort((a, b) => b.rss - a.rss);
      const h = this.history.get(g.prefix) || [];
      h.push(g.cpu);
      this.history.set(g.prefix, h.slice(-HISTORY));
      g.history = this.history.get(g.prefix);
    }
    for (const k of this.history.keys()) if (!byPrefix.has(k)) this.history.delete(k);

    const app = { cpu: 0, rss: 0 };
    for (const m of this.appMetrics()) { app.cpu += m.cpu.percentCPUUsage; app.rss += m.memory.workingSetSize * 1024; }
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

module.exports = { Resources };
