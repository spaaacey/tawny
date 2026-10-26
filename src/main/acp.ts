// ACP client for chat tabs: one adapter process per tab, JSON-RPC over stdio. Everything that talks ACP
// stays in this file so a protocol version switch is local. See docs/chat-tabs-plan.md.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { emptyModel, fold } from '../shared/chat-model';
import { Terminals } from './acp-terminals';
import * as F from './files';
import type { Store } from './store';
import type { Any } from './types';

const ADAPTER = path
  .join(__dirname, '..', '..', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// Run the ESM adapter with Electron as node, but drop ELECTRON_RUN_AS_NODE first so it doesn't leak into the agent's shell.
const LAUNCHER = 'delete process.env.ELECTRON_RUN_AS_NODE; import(require("url").pathToFileURL(process.argv[1]).href)';
const CLIENT_CAPS = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
  auth: { terminal: true },
  _meta: { terminal_output: true },
  session: { notices: {}, compaction: {} },
};
const TERM_FLUSH_MS = 80;
const CLOSE_MS = 1500;
const BUFFER_MS = 1000;
const MAX_GAP_MS = 1200; // fixture replay: cap on the recorded gap between two messages

let sdk: Promise<Any> | undefined;
const loadSdk = () => sdk || (sdk = import('@agentclientprotocol/sdk'));

/** `claude` from the (login-shell) PATH, or null. */
function findClaude() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, 'claude');
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
}

/** An executable named `cmd` (absolute, ~/…, or on the PATH), or null. */
function findOnPath(cmd: string | undefined) {
  cmd = String(cmd || '').replace(/^~(?=$|\/)/, os.homedir());
  const dirs = cmd.includes(path.sep) ? [''] : (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const f = dir ? path.join(dir, cmd) : cmd;
    try {
      fs.accessSync(f, fs.constants.X_OK);
      if (fs.statSync(f).isFile()) return f;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The ACP agents a chat tab can start: the bundled Claude adapter plus `acpAgents` ({name: {command, args, env, label}}). */
export interface AgentSpec {
  name: string;
  label: string;
  builtin: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function agentList(settings?: Partial<Store['settings']>): Record<string, AgentSpec> {
  const out: Record<string, AgentSpec> = { claude: { name: 'claude', label: 'Claude', builtin: true } };
  const mine = settings && settings.acpAgents && typeof settings.acpAgents === 'object' ? settings.acpAgents : {};
  for (const [name, a] of Object.entries(mine) as [string, Any][]) {
    if (name === 'claude' || !a || typeof a.command !== 'string' || !a.command.trim()) continue;
    out[name] = {
      name,
      label: typeof a.label === 'string' && a.label ? a.label : name,
      builtin: false,
      command: a.command.trim(),
      args: Array.isArray(a.args) ? a.args.map(String) : [],
      env: a.env && typeof a.env === 'object' ? a.env : {},
    };
  }
  return out;
}

/** The agent `name` (default: settings.chatAgent), or throws. */
function resolveAgent(settings?: Partial<Store['settings']>, name?: string): AgentSpec {
  const all = agentList(settings);
  const n = name || (settings && settings.chatAgent) || 'claude';
  if (!all[n]) throw new Error(`Unknown chat agent "${n}". Define it under acpAgents in harbor.json.`);
  return all[n];
}

/** Program, argv and env that start `agent`'s ACP server (plus `args`/`env` the agent's auth method adds for a terminal login). */
function launchOf(
  agent: AgentSpec,
  { claude, args = [], env = {} }: { claude?: string | null; args?: string[]; env?: Record<string, string> } = {},
) {
  if (agent.builtin) {
    // ELECTRON_RUN_AS_NODE only for the adapter's own process: the launcher drops it before the agent's tools run
    return {
      file: process.execPath,
      args: ['-e', LAUNCHER, ADAPTER, ...args],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CODE_EXECUTABLE: claude ?? '',
        CLAUDE_CODE_AUTO_CONNECT_IDE: 'false',
        CLAUDE_AGENT_ACP_PROTOCOL: 'v1',
        ...env,
      },
    };
  }
  return {
    file: findOnPath(agent.command) || (agent.command as string),
    args: [...(agent.args ?? []), ...args],
    env: { ...process.env, ...agent.env, ...env },
  };
}

/** The adapter says "sign in" with JSON-RPC -32000 (ACP's auth_required). */
const isAuthError = (e: Any) => !!e && e.code === -32000 && /auth/i.test(e.message || '');

const timeout = (p: Promise<unknown>, ms: number) => Promise.race([p, new Promise((r) => setTimeout(r, ms))]);

/** Plays a recorded session (test/fixtures/acp/*.jsonl) instead of an agent, for UI work without spending tokens. */
interface Handlers {
  notify(method: string, params: Any): void;
  request(method: string, params: Any): Promise<Any>;
}
interface Agent {
  request(method: string, params?: unknown): Promise<Any>;
  notify(method: string, params?: unknown): void | Promise<void>;
  close(): void;
}

class FixtureAgent implements Agent {
  lines: Any[];
  cancelled = false;
  promptAt: number;
  newAt: number;

  constructor(
    file: string,
    readonly h: Handlers,
  ) {
    this.lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.dir === 'in' || l.dir === 'out');
    const reqIdx = (method: string) => this.lines.findIndex((l: Any) => l.dir === 'out' && l.msg.method === method);
    this.promptAt = reqIdx('session/prompt');
    this.newAt = reqIdx('session/new');
    if (this.promptAt < 0 || this.newAt < 0)
      throw new Error(`fixture ${path.basename(file)} has no session/new + session/prompt`);
  }

  result(idx: number) {
    const id = this.lines[idx].msg.id;
    const r = this.lines.find((l: Any) => l.dir === 'in' && l.msg.id === id && !l.msg.method);
    return r && r.msg.result;
  }

  async request(method: string, params?: Any): Promise<Any> {
    if (method === 'initialize')
      return this.result(this.lines.findIndex((l: Any) => l.dir === 'out' && l.msg.method === 'initialize'));
    if (method === 'session/list') return { sessions: [] };
    if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
      const res = this.result(this.newAt);
      // notifications recorded between session/new and the prompt (commands, mode) arrive right after it
      setTimeout(() => {
        for (const l of this.lines.slice(this.newAt, this.promptAt))
          if (l.dir === 'in' && l.msg.method === 'session/update') this.h.notify('session/update', l.msg.params);
      }, 0);
      return res;
    }
    if (method === 'session/prompt') return this.play();
    if (method === 'session/set_config_option')
      return {
        configOptions: (this.result(this.newAt).configOptions || []).map((o: Any) =>
          o.id === params.configId ? { ...o, currentValue: params.value } : o,
        ),
      };
    return {};
  }

  notify(method: string) {
    if (method === 'session/cancel') this.cancelled = true;
  }

  async play() {
    this.cancelled = false;
    const promptId = this.lines[this.promptAt].msg.id;
    let prev = this.lines[this.promptAt].t;
    for (const l of this.lines.slice(this.promptAt + 1)) {
      if (l.dir !== 'in') continue;
      if (this.cancelled) return { stopReason: 'cancelled' };
      const m = l.msg;
      await new Promise((r) => setTimeout(r, Math.min(MAX_GAP_MS, Math.max(0, l.t - prev))));
      prev = l.t;
      if (m.id === promptId && !m.method) return m.result;
      if (m.method && m.id !== undefined)
        await this.h.request(m.method, m.params); // e.g. permission: wait for the UI's answer
      else if (m.method) this.h.notify(m.method, m.params);
    }
    return { stopReason: 'end_turn' };
  }

  close() {}
}

/** One chat tab's ACP session: adapter process, transcript model, working/waiting/idle state. */
export interface SavedChat {
  agent?: string;
  sessionId?: string | null;
  cwd?: string;
  started?: boolean;
  title?: string | null;
  usage?: unknown;
}
export type ChatStatus = 'starting' | 'ready' | 'no-claude' | 'no-agent' | 'auth-required' | 'disconnected' | 'error';

class Chat extends EventEmitter {
  id: string;
  spec: AgentSpec;
  authMethods: Any[] = [];
  caps: Any = null;
  agentInfo: Any = null;
  terms: Terminals | null = null; // client terminals, created on the agent's first terminal/create
  termBuf = new Map<string, string>(); // terminal id -> output waiting for the next flush
  termTimer: ReturnType<typeof setTimeout> | null = null;
  cwd: string;
  dataDir: string;
  model: Any = emptyModel();
  started: boolean; // a prompt was sent, so the agent has a transcript to load
  restore: boolean;
  seq = 0;
  status: ChatStatus = 'starting';
  error: string | null = null;
  state: 'idle' | 'working' | 'waiting' = 'idle';
  turns = 0; // prompts in flight
  reqSeq = 0;
  pending = new Map<number, { resolve: (v: Any) => void }>();
  fileReqs = new Map<number, (text: string | null) => void>(); // for unsaved-buffer lookups answered by the renderer
  proc: ChildProcess | null = null;
  conn: Any = null;
  agent: Agent | null = null;
  sessionId: string | null;
  gen = 0; // bumps when the connection is dropped, so turns of the old one don't touch the new one's counters
  closed = false;

  /** `agent`: from resolveAgent. `dataDir`: where the adapter's stderr log goes. `saved`: {sessionId, started, title, usage} of a conversation to bring back. */
  constructor({
    id,
    cwd,
    dataDir,
    saved,
    agent,
  }: { id: string; cwd: string; dataDir: string; saved?: SavedChat | null; agent?: AgentSpec }) {
    super();
    this.id = id;
    this.spec = agent || resolveAgent({});
    this.cwd = cwd;
    this.dataDir = dataDir;
    this.started = !!(saved && saved.started);
    this.restore = this.started;
    if (saved) {
      this.model.title = saved.title || null;
      this.model.usage = saved.usage || null;
    } // replay doesn't carry either
    this.sessionId = (saved && saved.sessionId) || null;
  }

  get rpc(): Agent {
    if (!this.agent) throw new Error('Not connected');
    return this.agent;
  }

  get pid() {
    return this.proc ? this.proc.pid : null;
  }

  /** Spawn the adapter and open the conversation: a fresh one, or (restore) `session/load`, whose replay rebuilds the transcript. */
  start() {
    return this.open(this.restore ? 'load' : 'new');
  }

  /** mode: 'new' | 'load' (replays the transcript) | 'resume' (no replay). */
  async open(mode: 'new' | 'load' | 'resume') {
    try {
      const fixture = process.env.HARBOR_ACP_FIXTURE;
      if (fixture)
        this.agent = new FixtureAgent(fixture, {
          notify: (m, p) => this.onNotify(m, p),
          request: (m, p) => this.onRequest(m, p),
        });
      else {
        let claude = null;
        if (this.spec.builtin) {
          claude = findClaude();
          if (!claude) return this.setStatus('no-claude');
        } else if (!findOnPath(this.spec.command))
          return this.setStatus('no-agent', `Couldn't find "${this.spec.command}" on your PATH.`);
        this.agent = await this.connect(claude);
      }
      const init = await this.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: this.clientCaps(),
        clientInfo: { name: 'tawny', version: '0.2.0' },
      });
      this.agentInfo = init.agentInfo || null;
      this.caps = init.agentCapabilities || null;
      this.authMethods = init.authMethods || [];
      let res: Any;
      if (mode === 'new' || !this.sessionId) res = await this.newSession();
      else {
        try {
          res = await this.rpc.request(mode === 'load' ? 'session/load' : 'session/resume', {
            sessionId: this.sessionId,
            cwd: this.cwd,
            mcpServers: [],
          });
        } catch (e) {
          if (mode !== 'load') throw e;
          // the transcript is gone (deleted, or the first prompt never reached the agent): start over in the same tab
          res = await this.newSession();
          this.push({ sessionUpdate: 'notice', text: `Couldn't restore the previous conversation: ${e.message || e}` });
        }
      }
      if (res && res.configOptions) this.model.configOptions = res.configOptions;
      if (res && res.modes) this.model.currentModeId = res.modes.currentModeId;
      this.setStatus('ready');
      this.persist();
    } catch (e) {
      if (this.closed) return;
      if (isAuthError(e)) this.setStatus('auth-required', e.message);
      else this.setStatus('error', e.message);
    }
  }

  /** Claude Code runs its own commands; every other agent gets our terminals. */
  clientCaps() {
    return { ...CLIENT_CAPS, terminal: !this.spec.builtin };
  }

  async newSession() {
    const ns = await this.rpc.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.sessionId = ns.sessionId;
    this.started = false;
    await this.defaultMode(ns);
    return ns;
  }

  /** New Claude sessions start in "bypassPermissions" (when the adapter offers it). */
  async defaultMode(ns: Any) {
    if (!this.spec.builtin) return;
    const mode = (ns.configOptions || []).find((o: Any) => o.category === 'mode');
    if (!mode || mode.currentValue === 'bypassPermissions') return;
    const has = (mode.options || [])
      .flatMap((x: Any) => x.options || [x])
      .some((x: Any) => x.value === 'bypassPermissions');
    if (!has) return;
    try {
      const res = await this.rpc.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: mode.id,
        value: 'bypassPermissions',
      });
      if (res && res.configOptions) ns.configOptions = res.configOptions;
    } catch {
      /* keep the adapter's default */
    }
  }

  /** `/clear`: a fresh conversation in the same tab; the old one is deleted like on tab close. */
  async clear() {
    if (this.closed || this.status !== 'ready' || this.turns)
      throw new Error('Wait for the current turn to finish before clearing.');
    const old = this.sessionId;
    const res = await this.newSession();
    if (res && res.configOptions) this.model.configOptions = res.configOptions;
    this.cancelPending();
    this.push({ sessionUpdate: 'x_clear' });
    this.persist();
    if (old) {
      const sc = (this.caps && this.caps.sessionCapabilities) || null;
      const gone = (m: string) => Promise.resolve(this.rpc.request(m, { sessionId: old })).catch(() => {});
      if (!sc || sc.delete) await timeout(gone('session/delete'), CLOSE_MS);
      if (!sc || sc.close) await timeout(gone('session/close'), CLOSE_MS);
    }
  }

  /** Respawn the adapter after a crash and `session/resume` (no replay: the transcript is still here). */
  async reconnect() {
    if (this.closed || !['disconnected', 'error', 'auth-required', 'no-agent', 'no-claude'].includes(this.status))
      return;
    this.drop();
    this.setStatus('starting');
    await this.open(this.started ? 'resume' : 'new');
  }

  /** Let go of the adapter process and connection without closing the chat. */
  drop() {
    this.gen++;
    this.closeTerminals();
    this.cancelPending();
    this.turns = 0;
    this.setState();
    const { agent, proc } = this;
    this.agent = this.conn = this.proc = null;
    try {
      agent && agent.close();
    } catch {
      /* */
    }
    try {
      proc && proc.kill();
    } catch {
      /* */
    }
  }

  /** Tell the owner what to keep across a restart. */
  persist() {
    if (this.sessionId)
      this.emit('persist', {
        agent: this.spec.name,
        sessionId: this.sessionId,
        cwd: this.cwd,
        started: this.started,
        title: this.model.title,
        usage: this.model.usage,
      });
  }

  async connect(claude: string | null): Promise<Agent> {
    const { client, ndJsonStream, methods } = await loadSdk();
    fs.mkdirSync(path.join(this.dataDir, 'logs'), { recursive: true });
    const logFile = path.join(this.dataDir, 'logs', `acp-${this.id}.log`);
    const log = fs.createWriteStream(logFile);
    const launch = launchOf(this.spec, { claude });
    const proc = (this.proc = spawn(launch.file, launch.args, {
      cwd: this.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    log.write(
      `[tawny] spawn pid=${proc.pid} agent=${this.spec.name} ${this.spec.builtin ? `claude=${claude} adapter=${ADAPTER}` : [launch.file, ...launch.args].join(' ')}\n`,
    );
    proc.stderr.pipe(log);
    proc.on('error', (e) => {
      if (this.proc === proc) this.lost(`Couldn't start the agent: ${e.message}`);
    });
    proc.on('exit', (code, sig) => {
      setTimeout(() => fs.appendFile(logFile, `[tawny] exit code=${code} signal=${sig}\n`, () => {}), 100);
      if (this.proc === proc) this.lost(`Agent exited (${sig || code})`);
    });
    // both versions in the log make adapter/claude skew easy to spot
    if (claude)
      try {
        log.write(
          `[tawny] claude ${execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim()}\n`,
        );
      } catch {
        /* */
      }
    const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const app = client({ name: 'tawny', version: '0.2.0' })
      .onRequest(methods.client.session.requestPermission, ({ params }: Any) =>
        this.onRequest('session/request_permission', params),
      )
      .onRequest(methods.client.fs.readTextFile, ({ params }: Any) => this.onRequest('fs/read_text_file', params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }: Any) => this.onRequest('fs/write_text_file', params))
      .onRequest(methods.client.terminal.create, ({ params }: Any) => this.onRequest('terminal/create', params))
      .onRequest(methods.client.terminal.output, ({ params }: Any) => this.onRequest('terminal/output', params))
      .onRequest(methods.client.terminal.waitForExit, ({ params }: Any) =>
        this.onRequest('terminal/wait_for_exit', params),
      )
      .onRequest(methods.client.terminal.kill, ({ params }: Any) => this.onRequest('terminal/kill', params))
      .onRequest(methods.client.terminal.release, ({ params }: Any) => this.onRequest('terminal/release', params))
      .onNotification(methods.client.session.update, ({ params }: Any) => this.onNotify('session/update', params))
      .onNotification('*', (ctx: Any) => this.onNotify(ctx.method, ctx.params));
    const conn = (this.conn = app.connect(stream));
    return {
      request: (method: string, params?: unknown) => conn.agent.request(method, params),
      notify: (method: string, params?: unknown) => conn.agent.notify(method, params),
      close: () => {
        try {
          conn.close();
        } catch {
          /* */
        }
      },
    };
  }

  /** Adapter went away without us asking. */
  lost(msg: string) {
    if (this.closed || this.status === 'disconnected') return;
    this.gen++;
    this.closeTerminals();
    this.cancelPending();
    this.turns = 0;
    this.setState();
    this.setStatus('disconnected', msg);
  }

  setStatus(status: ChatStatus, error: string | null = null) {
    this.status = status;
    this.error = error;
    this.emit('status', { status, error, auth: this.authList() });
  }

  /** working: a prompt is open; waiting: a permission request is open; else idle. */
  setState() {
    const state = this.pending.size ? 'waiting' : this.turns ? 'working' : 'idle';
    if (state === this.state) return;
    this.state = state;
    this.emit('state', state);
  }

  push(update: Any) {
    fold(this.model, update);
    this.emit('update', { seq: ++this.seq, update });
    if (update.sessionUpdate === 'session_info_update' || update.sessionUpdate === 'usage_update') this.persist();
  }

  onNotify(method: string, params: Any) {
    if (method === 'session/update') this.push(params.update);
    else if (method === '_auth/status_update')
      this.model.auth = params.authStatus ? params.authStatus.label || params.authStatus.kind : null; // never keep the account email
  }

  onRequest(method: string, params: Any): Any {
    if (method === 'session/request_permission') return this.askPermission(params);
    if (method === 'fs/read_text_file') return this.readFile(params);
    if (method === 'fs/write_text_file') return F.write(params.path, params.content).then(() => ({}));
    if (method.startsWith('terminal/')) return this.terminalRequest(method, params);
    throw new Error(`unsupported client method ${method}`);
  }

  terminalRequest(method: string, params: Any) {
    const T = this.terminals();
    switch (method) {
      case 'terminal/create':
        return T.create({ ...params, cwd: params.cwd || this.cwd });
      case 'terminal/output':
        return T.output(params.terminalId);
      case 'terminal/wait_for_exit':
        return T.waitForExit(params.terminalId);
      case 'terminal/kill':
        T.kill(params.terminalId);
        return {};
      default:
        T.release(params.terminalId);
        return {}; // terminal/release
    }
  }

  terminals() {
    return (
      this.terms ||
      (this.terms = new Terminals({
        cwd: this.cwd,
        onData: (tid, data) => {
          this.termBuf.set(tid, (this.termBuf.get(tid) || '') + data);
          if (!this.termTimer) this.termTimer = setTimeout(() => this.flushTerminals(), TERM_FLUSH_MS);
        },
        onExit: (tid, exit) => {
          this.flushTerminals();
          this.push({ sessionUpdate: 'x_terminal', terminalId: tid, exit });
        },
      }))
    );
  }

  /** Terminal output reaches the card in batches, not per pty chunk. */
  flushTerminals() {
    if (this.termTimer) clearTimeout(this.termTimer);
    this.termTimer = null;
    const bufs = [...this.termBuf];
    this.termBuf.clear();
    for (const [terminalId, data] of bufs) this.push({ sessionUpdate: 'x_terminal', terminalId, data });
  }

  closeTerminals() {
    if (this.termTimer) clearTimeout(this.termTimer);
    this.termTimer = null;
    this.termBuf.clear();
    if (this.terms) this.terms.closeAll();
    this.terms = null;
  }

  /** Answer an `agent`-type auth method (the agent handles login itself), then start over. */
  async authenticate(methodId: string) {
    if (!this.agent) throw new Error('Not connected');
    await this.rpc.request('authenticate', { methodId });
    this.setStatus('error', null); // let reconnect() run
    return this.reconnect();
  }

  /** Auth methods for the UI. A terminal method's `run` is the command line to run, in a terminal tab, to log in. */
  authList() {
    return (this.authMethods || []).map((m: Any) => ({
      id: m.id,
      name: m.name,
      description: m.description || null,
      terminal: m.type === 'terminal',
    }));
  }

  /** Program + argv + env for a terminal auth method: the agent's own command line with the method's args appended. */
  authLaunch(methodId: string) {
    const m = (this.authMethods || []).find((x: Any) => x.id === methodId && x.type === 'terminal');
    if (!m) throw new Error('No such sign-in method');
    return launchOf(this.spec, { claude: findClaude(), args: m.args || [], env: m.env || {} });
  }

  askPermission(params: Any) {
    const reqId = ++this.reqSeq;
    const req = { reqId, toolCall: params.toolCall, options: params.options };
    return new Promise((resolve) => {
      this.pending.set(reqId, { resolve });
      this.model.pending.push(req);
      this.setState();
      this.emit('permission', req);
    });
  }

  /** The renderer's answer: an optionId, or null for cancelled. */
  answer(reqId: number, optionId: string | null) {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    this.model.pending = this.model.pending.filter((r: Any) => r.reqId !== reqId);
    p.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
    this.setState();
    this.emit('permission-done', reqId);
  }

  cancelPending() {
    for (const reqId of [...this.pending.keys()]) this.answer(reqId, null);
  }

  /** Unsaved text of `file` from the editor, or null (not open, clean, or the renderer didn't answer). */
  askBuffer(file: string) {
    const reqId = ++this.reqSeq;
    return new Promise<string | null>((resolve) => {
      const t = setTimeout(() => {
        this.fileReqs.delete(reqId);
        resolve(null);
      }, BUFFER_MS);
      this.fileReqs.set(reqId, (text) => {
        clearTimeout(t);
        resolve(text);
      });
      this.emit('file-request', { reqId, path: file });
    });
  }

  fileReply(reqId: number, text: unknown) {
    const r = this.fileReqs.get(reqId);
    if (!r) return;
    this.fileReqs.delete(reqId);
    r(typeof text === 'string' ? text : null);
  }

  async readFile({ path: file, line, limit }: { path: string; line?: number; limit?: number }) {
    const dirty = this.listenerCount('file-request') ? await this.askBuffer(file) : null;
    const lines = (dirty != null ? dirty : await fs.promises.readFile(file, 'utf8')).split('\n');
    const from = line ? line - 1 : 0;
    return { content: (limit ? lines.slice(from, from + limit) : lines.slice(from)).join('\n') };
  }

  /** blocks: ACP content blocks. Resolves with the stop reason when the turn ends. */
  async prompt(blocks: Any[]) {
    if (this.status !== 'ready') throw new Error(`Chat is not ready (${this.status})`);
    const text = blocks
      .map((b: Any) =>
        b.type === 'text' ? b.text : b.type === 'resource_link' ? `@${b.name}` : b.type === 'image' ? '[image]' : '',
      )
      .join('');
    this.push({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text },
      messageId: `local-${++this.seq}`,
    });
    this.turns++;
    const gen = this.gen;
    this.setState();
    if (!this.started) {
      this.started = true;
      this.persist();
    }
    try {
      const res = await this.rpc.request('session/prompt', { sessionId: this.sessionId, prompt: blocks });
      return res.stopReason;
    } catch (e) {
      if (isAuthError(e)) this.setStatus('auth-required', e.message);
      else this.push({ sessionUpdate: 'notice', text: e.message || String(e) });
      return 'error';
    } finally {
      if (gen === this.gen) {
        this.turns--;
        this.setState();
      }
    }
  }

  cancel() {
    if (!this.agent || !this.sessionId) return;
    this.cancelPending();
    try {
      Promise.resolve(this.rpc.notify('session/cancel', { sessionId: this.sessionId })).catch(() => {});
    } catch {
      /* */
    }
  }

  async setConfig(configId: string, value: unknown) {
    const res = await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    if (res && res.configOptions)
      this.push({ sessionUpdate: 'config_option_update', configOptions: res.configOptions });
  }

  history() {
    return {
      seq: this.seq,
      status: this.status,
      error: this.error,
      state: this.state,
      sessionId: this.sessionId,
      model: this.model,
      agent: { name: this.spec.name, label: this.spec.label, builtin: !!this.spec.builtin },
      auth: this.authList(),
    };
  }

  /** Tab closed: delete the conversation, like closing a terminal agent deletes its transcript. Quit: just stop (`keep`). */
  async close({ keep = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    this.closeTerminals();
    if (this.agent && this.sessionId && this.status === 'ready' && !keep) {
      const sc = (this.caps && this.caps.sessionCapabilities) || null; // unknown capabilities: try anyway
      if (!sc || sc.delete)
        await timeout(
          Promise.resolve(this.rpc.request('session/delete', { sessionId: this.sessionId })).catch(() => {}),
          CLOSE_MS,
        );
      if (!sc || sc.close)
        await timeout(
          Promise.resolve(this.rpc.request('session/close', { sessionId: this.sessionId })).catch(() => {}),
          CLOSE_MS,
        );
    }
    try {
      this.agent && this.agent.close();
    } catch {
      /* */
    }
    try {
      this.proc && this.proc.kill();
    } catch {
      /* */
    }
    if (!keep) this.dropTranscript(); // the agent may have been gone (crashed) or not have deleted it
    this.removeAllListeners();
  }

  /** Claude Code's own copy of this conversation: ~/.claude/projects/<cwd, non-alphanumerics -> '-'>/<sessionId>.jsonl (+ a sidecar dir). */
  dropTranscript() {
    if (!this.spec.builtin || !this.started || !/^[\w-]+$/.test(this.sessionId || '') || process.env.HARBOR_ACP_FIXTURE)
      return; // Claude Code's layout only
    try {
      const dir = path.join(
        os.homedir(),
        '.claude',
        'projects',
        fs.realpathSync(this.cwd).replace(/[^a-zA-Z0-9]/g, '-'),
      );
      fs.rmSync(path.join(dir, `${this.sessionId}.jsonl`), { force: true });
      fs.rmSync(path.join(dir, this.sessionId as string), { recursive: true, force: true });
    } catch {
      /* cwd gone or nothing there */
    }
  }

  /** The agent's conversations for `cwd` (history picker), newest first. Spawns a short-lived adapter. */
  static async list(cwd: string, dataDir: string, agent?: AgentSpec) {
    const probe = new Chat({ id: 'list', cwd, dataDir, agent });
    try {
      const fixture = process.env.HARBOR_ACP_FIXTURE;
      if (fixture) return [];
      const claude = probe.spec.builtin ? findClaude() : null;
      if (probe.spec.builtin && !claude) throw new Error('Claude Code is not installed');
      if (!probe.spec.builtin && !findOnPath(probe.spec.command))
        throw new Error(`Couldn't find "${probe.spec.command}" on your PATH.`);
      probe.agent = await probe.connect(claude);
      await probe.rpc.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: probe.clientCaps(),
        clientInfo: { name: 'tawny', version: '0.2.0' },
      });
      const res = await probe.rpc.request('session/list', { cwd });
      return (res.sessions || [])
        .map((x: Any) => ({ sessionId: x.sessionId, title: x.title || null, updatedAt: x.updatedAt || null }))
        .sort((a: Any, b: Any) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } finally {
      probe.close({ keep: true }).catch(() => {});
    }
  }
}

export { agentList, Chat, findClaude, launchOf, resolveAgent };
