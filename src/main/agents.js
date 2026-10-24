'use strict';
// Agent sessions. With tmux: each agent is a tmux session (survives quitting Harbor) and
// Harbor holds a pty attached to it. Without tmux: Harbor owns the shell pty directly.
const { EventEmitter } = require('events');
const os = require('os');
const pty = require('node-pty');
const G = require('./git');

const WORKING_MS = 2500;   // output within this window => working
const IDLE_MS = 7000;      // quiet this long => idle
const NOTIFY_MIN_MS = 6000; // only notify if it worked at least this long
const RESIZE_QUIET_MS = 1500; // ignore redraw output right after a resize/attach
const SCROLLBACK = 400 * 1024;

class Agents extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    this.sessions = new Map(); // id -> {id, prefix, index, pty, buf, lastOut, working, workStart, quietUntil, cols, rows, tmux}
    this.tmux = false;
    this.timer = null;
  }

  async init() {
    this.tmux = this.store.settings.useTmux && process.platform !== 'win32' && await G.hasTmux();
    await this.discover();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  list() {
    return [...this.sessions.values()].map(s => ({
      id: s.id, prefix: s.prefix, index: s.index, working: s.working, tmux: s.tmux,
    }));
  }

  forPrefix(prefix) {
    return this.list().filter(s => s.prefix === prefix).sort((a, b) => a.index - b.index);
  }

  /** Attach to every existing harbor tmux session (from earlier runs or the VS Code extension). */
  async discover() {
    if (!this.tmux) return;
    for (const s of await G.listSessions()) {
      if (!this.sessions.has(s.name)) this.attachTmux(s.name);
    }
  }

  splitName(name) {
    const i = name.lastIndexOf('_');
    return { prefix: name.slice(0, i), index: Number(name.slice(i + 1)) || 1 };
  }

  spawnPty(file, args, cwd) {
    return pty.spawn(file, args, {
      name: 'xterm-256color', cols: 120, rows: 32, cwd: cwd || os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TMUX: '' },
    });
  }

  register(id, p, extra) {
    const { prefix, index } = this.splitName(id);
    const s = {
      id, prefix, index, pty: p, buf: '', lastOut: 0, working: false, workStart: 0,
      quietUntil: Date.now() + RESIZE_QUIET_MS, cols: 120, rows: 32, ...extra,
    };
    this.sessions.set(id, s);
    this.bind(s, p);
    this.emit('changed');
    return s;
  }

  bind(s, p) {
    s.pty = p;
    s.quietUntil = Date.now() + RESIZE_QUIET_MS;
    p.onData(d => {
      s.buf += d;
      if (s.buf.length > SCROLLBACK) s.buf = s.buf.slice(s.buf.length - SCROLLBACK);
      if (Date.now() > s.quietUntil) s.lastOut = Date.now();
      this.emit('data', s.id, d);
    });
    p.onExit(() => this.onExit(s.id, p));
  }

  attachTmux(name, cwd) {
    if (this.tmux) {
      try { require('child_process').execFileSync('tmux', ['set-option', '-t', name, 'window-size', 'latest']); } catch { /* old tmux */ }
    }
    const p = this.spawnPty('tmux', ['attach-session', '-t', name], cwd);
    return this.register(name, p, { tmux: true });
  }

  async onExit(id, p) {
    const s = this.sessions.get(id);
    if (!s || s.pty !== p) return;
    if (s.tmux && !s.killed) {
      // client died but the tmux session may still be alive -> reattach
      const alive = (await G.listSessions()).some(x => x.name === id);
      const flapping = Date.now() - (s.lastReattach || 0) < 3000;
      if (alive && !flapping) {
        s.lastReattach = Date.now();
        const np = this.spawnPty('tmux', ['attach-session', '-t', id]);
        this.bind(s, np);
        try { np.resize(s.cols, s.rows); } catch { /* */ }
        return;
      }
    }
    this.sessions.delete(id);
    this.emit('exit', id);
    this.emit('changed');
  }

  nextName(prefix) {
    const used = this.forPrefix(prefix).map(s => s.index);
    return `${prefix}_${used.length ? Math.max(...used) + 1 : 1}`;
  }

  /** Start a new agent in a worktree. */
  async create(worktreePath, opts = {}) {
    try {
      const s = await this._create(worktreePath, opts);
      if (this.lastError) { this.lastError = null; this.emit('changed'); }
      return s;
    } catch (e) {
      this.lastError = /posix_spawn/i.test(e.message)
        ? `Couldn't start a terminal (${e.message}). Run: chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
        : e.message;
      this.emit('changed');
      throw new Error(this.lastError);
    }
  }

  async _create(worktreePath, { resume = false } = {}) {
    const st = this.store.settings;
    const command = (resume && st.resumeCommand) || st.agentCommand || '';
    const prefix = G.sessionPrefix(worktreePath);
    const name = this.nextName(prefix);
    this.remember(name);
    if (this.tmux) {
      await G.createSession(name, worktreePath, command);
      return this.attachTmux(name, worktreePath);
    }
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'powershell.exe') : (process.env.SHELL || '/bin/zsh');
    const p = this.spawnPty(shell, process.platform === 'win32' ? [] : ['-l'], worktreePath);
    const s = this.register(name, p, { tmux: false });
    if (command) setTimeout(() => p.write(command + '\r'), 300);
    return s;
  }

  /** Open agents for a worktree: existing ones, or a new (resumed if it had agents before) one. */
  async ensure(worktreePath) {
    const prefix = G.sessionPrefix(worktreePath);
    const have = this.forPrefix(prefix);
    if (have.length) return have[0];
    const resume = (this.store.data.knownSessions || []).some(n => n.startsWith(prefix + '_'));
    return this.create(worktreePath, { resume });
  }

  remember(name) {
    const k = new Set(this.store.data.knownSessions || []);
    k.add(name);
    this.store.set('knownSessions', [...k].slice(-500));
  }

  forget(prefix) {
    this.store.set('knownSessions', (this.store.data.knownSessions || []).filter(n => !n.startsWith(prefix + '_')));
  }

  write(id, data) { const s = this.sessions.get(id); if (s) s.pty.write(data); }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (!s || !cols || !rows || (s.cols === cols && s.rows === rows)) return;
    s.cols = cols; s.rows = rows;
    s.quietUntil = Date.now() + RESIZE_QUIET_MS;
    try { s.pty.resize(cols, rows); } catch { /* exited */ }
  }

  buffer(id) { const s = this.sessions.get(id); return s ? s.buf : ''; }

  async kill(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.killed = true;
    if (s.tmux) await G.killSession(id);
    try { s.pty.kill(); } catch { /* */ }
    this.sessions.delete(id);
    this.emit('exit', id);
    this.emit('changed');
  }

  async killPrefix(prefix) {
    for (const s of this.forPrefix(prefix)) await this.kill(s.id);
    // also sessions not attached here
    if (this.tmux) for (const t of await G.listSessions()) if (t.name.startsWith(prefix + '_')) await G.killSession(t.name);
  }

  tick() {
    const now = Date.now();
    let changed = false;
    for (const s of this.sessions.values()) {
      const quiet = now - s.lastOut;
      if (!s.working && quiet < WORKING_MS) { s.working = true; s.workStart = now; changed = true; }
      else if (s.working && quiet > IDLE_MS) {
        s.working = false; changed = true;
        if (now - s.workStart - IDLE_MS >= NOTIFY_MIN_MS) this.emit('finished', s.id);
      }
    }
    if (changed) this.emit('changed');
  }

  /** Detach everything (tmux sessions keep running). */
  dispose() {
    clearInterval(this.timer);
    for (const s of this.sessions.values()) {
      s.killed = true;
      try { s.pty.kill(); } catch { /* */ }
    }
  }
}

module.exports = { Agents };
