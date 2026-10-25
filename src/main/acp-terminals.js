'use strict';
// Client side of ACP `terminal/*`: agents that don't run their own commands (everything but Claude Code) ask us to,
// and we run them in a pty. Output goes back to the agent on request and, through `onData`, to the tool card.
const path = require('path');
const pty = require('node-pty');

const DEFAULT_LIMIT = 1 << 20;

/** Keep the last `limit` bytes of `s`. */
function tail(s, limit) {
  while (Buffer.byteLength(s) > limit) s = s.slice(Math.max(1, Math.ceil((Buffer.byteLength(s) - limit) / 3)));
  return s;
}

class Terminals {
  /** `onData(id, data)` and `onExit(id, {exitCode, signal})` feed the UI. */
  constructor({ cwd, onData, onExit }) {
    this.cwd = cwd;
    this.onData = onData;
    this.onExit = onExit;
    this.terms = new Map(); // id -> {pty, output, truncated, limit, exit, waiters}
    this.seq = 0;
  }

  create({ command, args, env, cwd, outputByteLimit }) {
    const id = `term-${++this.seq}`;
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'powershell.exe') : (process.env.SHELL || '/bin/zsh');
    // a whole command line in `command` with no args is how some agents say "run this in a shell"
    const line = !(args && args.length) && /\s/.test(command);
    const file = line ? shell : command;
    const argv = line ? (process.platform === 'win32' ? ['-Command', command] : ['-c', command]) : (args || []);
    const e = { ...process.env, TERM: 'xterm-256color' };
    for (const v of env || []) e[v.name] = v.value;
    const t = { output: '', truncated: false, limit: outputByteLimit > 0 ? outputByteLimit : DEFAULT_LIMIT, exit: null, waiters: [], pty: null };
    t.pty = pty.spawn(file, argv, { name: 'xterm-256color', cols: 120, rows: 30, cwd: cwd ? path.resolve(cwd) : this.cwd, env: e });
    t.pty.onData(d => {
      t.output += d;
      if (Buffer.byteLength(t.output) > t.limit) { t.output = tail(t.output, t.limit); t.truncated = true; }
      this.onData(id, d);
    });
    t.pty.onExit(({ exitCode, signal }) => {
      t.exit = { exitCode, signal: signal ? String(signal) : null };
      for (const w of t.waiters) w(t.exit);
      t.waiters = [];
      this.onExit(id, t.exit);
    });
    this.terms.set(id, t);
    return { terminalId: id };
  }

  get(id) {
    const t = this.terms.get(id);
    if (!t) throw new Error(`Unknown terminal ${id}`);
    return t;
  }

  output(id) {
    const t = this.get(id);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }

  waitForExit(id) {
    const t = this.get(id);
    return t.exit ? Promise.resolve(t.exit) : new Promise(r => t.waiters.push(r));
  }

  kill(id) {
    const t = this.get(id);
    if (!t.exit) try { t.pty.kill(); } catch { /* already gone */ }
  }

  /** The agent is done with it: stop the process; the card keeps the output it already has. */
  release(id) {
    const t = this.terms.get(id);
    if (!t) return;
    this.kill(id);
    this.terms.delete(id);
  }

  closeAll() { for (const id of [...this.terms.keys()]) this.release(id); }
}

module.exports = { Terminals };
