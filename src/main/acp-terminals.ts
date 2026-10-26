// Client side of ACP `terminal/*`: agents that don't run their own commands (everything but Claude Code) ask us to,
// and we run them in a pty. Output goes back to the agent on request and, through `onData`, to the tool card.

import * as path from 'node:path';
import * as pty from 'node-pty';

const DEFAULT_LIMIT = 1 << 20;

/** Keep the last `limit` bytes of `s`. */
function tail(s: string, limit: number) {
  while (Buffer.byteLength(s) > limit) s = s.slice(Math.max(1, Math.ceil((Buffer.byteLength(s) - limit) / 3)));
  return s;
}

export interface TermExit {
  exitCode: number;
  signal: string | null;
}
interface Term {
  output: string;
  truncated: boolean;
  limit: number;
  exit: TermExit | null;
  waiters: ((e: TermExit) => void)[];
  pty: pty.IPty;
}
export interface TermOpts {
  command: string;
  args?: string[];
  env?: { name: string; value: string }[];
  cwd?: string;
  outputByteLimit?: number;
}

class Terminals {
  cwd: string;
  onData: (id: string, data: string) => void;
  onExit: (id: string, exit: TermExit) => void;
  terms = new Map<string, Term>();
  seq = 0;

  /** `onData(id, data)` and `onExit(id, {exitCode, signal})` feed the UI. */
  constructor({ cwd, onData, onExit }: { cwd: string; onData: Terminals['onData']; onExit: Terminals['onExit'] }) {
    this.cwd = cwd;
    this.onData = onData;
    this.onExit = onExit;
  }

  create({ command, args, env, cwd, outputByteLimit }: TermOpts) {
    const id = `term-${++this.seq}`;
    const shell =
      process.platform === 'win32' ? process.env.COMSPEC || 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    // a whole command line in `command` with no args is how some agents say "run this in a shell"
    const line = !(args && args.length) && /\s/.test(command);
    const file = line ? shell : command;
    const argv = line ? (process.platform === 'win32' ? ['-Command', command] : ['-c', command]) : args || [];
    const e: Record<string, string> = { ...(process.env as Record<string, string>), TERM: 'xterm-256color' };
    for (const v of env || []) e[v.name] = v.value;
    const p = pty.spawn(file, argv, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: cwd ? path.resolve(cwd) : this.cwd,
      env: e,
    });
    const t: Term = {
      output: '',
      truncated: false,
      limit: outputByteLimit && outputByteLimit > 0 ? outputByteLimit : DEFAULT_LIMIT,
      exit: null,
      waiters: [],
      pty: p,
    };
    t.pty.onData((d) => {
      t.output += d;
      if (Buffer.byteLength(t.output) > t.limit) {
        t.output = tail(t.output, t.limit);
        t.truncated = true;
      }
      this.onData(id, d);
    });
    t.pty.onExit(({ exitCode, signal }) => {
      const exit = { exitCode, signal: signal ? String(signal) : null };
      t.exit = exit;
      for (const w of t.waiters) w(exit);
      t.waiters = [];
      this.onExit(id, exit);
    });
    this.terms.set(id, t);
    return { terminalId: id };
  }

  get(id: string) {
    const t = this.terms.get(id);
    if (!t) throw new Error(`Unknown terminal ${id}`);
    return t;
  }

  output(id: string) {
    const t = this.get(id);
    return { output: t.output, truncated: t.truncated, exitStatus: t.exit };
  }

  waitForExit(id: string) {
    const t = this.get(id);
    return t.exit ? Promise.resolve(t.exit) : new Promise<TermExit>((r) => t.waiters.push(r));
  }

  kill(id: string) {
    const t = this.get(id);
    if (!t.exit)
      try {
        t.pty.kill();
      } catch {
        /* already gone */
      }
  }

  /** The agent is done with it: stop the process; the card keeps the output it already has. */
  release(id: string) {
    const t = this.terms.get(id);
    if (!t) return;
    this.kill(id);
    this.terms.delete(id);
  }

  closeAll() {
    for (const id of [...this.terms.keys()]) this.release(id);
  }
}

export { Terminals };
