'use strict';
// ACP client for chat tabs: one adapter process per tab, JSON-RPC over stdio. Everything that talks ACP
// stays in this file so a protocol version switch is local. See docs/chat-tabs-plan.md.
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Readable, Writable } = require('stream');
const { emptyModel, fold } = require('./chat-model');
const F = require('./files');
const { Terminals } = require('./acp-terminals');

const ADAPTER = path.join(__dirname, '..', '..', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// Run the ESM adapter with Electron as node, but drop ELECTRON_RUN_AS_NODE first so it doesn't leak into the agent's shell.
const LAUNCHER = 'delete process.env.ELECTRON_RUN_AS_NODE; import(require("url").pathToFileURL(process.argv[1]).href)';
const CLIENT_CAPS = { fs: { readTextFile: true, writeTextFile: true }, terminal: false, auth: { terminal: true }, _meta: { terminal_output: true }, session: { notices: {}, compaction: {} } };
const TERM_FLUSH_MS = 80;
const CLOSE_MS = 1500;
const BUFFER_MS = 1000;
const MAX_GAP_MS = 1200; // fixture replay: cap on the recorded gap between two messages

let sdk;
const loadSdk = () => sdk || (sdk = import('@agentclientprotocol/sdk'));

/** `claude` from the (login-shell) PATH, or null. */
function findClaude() {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, 'claude');
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/** An executable named `cmd` (absolute, ~/…, or on the PATH), or null. */
function findOnPath(cmd) {
  cmd = String(cmd || '').replace(/^~(?=$|\/)/, os.homedir());
  const dirs = cmd.includes(path.sep) ? [''] : (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    const f = dir ? path.join(dir, cmd) : cmd;
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
  }
  return null;
}

/** The ACP agents a chat tab can start: the bundled Claude adapter plus `acpAgents` ({name: {command, args, env, label}}). */
function agentList(settings) {
  const out = { claude: { name: 'claude', label: 'Claude', builtin: true } };
  const mine = settings && settings.acpAgents && typeof settings.acpAgents === 'object' ? settings.acpAgents : {};
  for (const [name, a] of Object.entries(mine)) {
    if (name === 'claude' || !a || typeof a.command !== 'string' || !a.command.trim()) continue;
    out[name] = { name, label: typeof a.label === 'string' && a.label ? a.label : name, builtin: false, command: a.command.trim(), args: Array.isArray(a.args) ? a.args.map(String) : [], env: a.env && typeof a.env === 'object' ? a.env : {} };
  }
  return out;
}

/** The agent `name` (default: settings.chatAgent), or throws. */
function resolveAgent(settings, name) {
  const all = agentList(settings);
  const n = name || (settings && settings.chatAgent) || 'claude';
  if (!all[n]) throw new Error(`Unknown chat agent "${n}". Define it under acpAgents in harbor.json.`);
  return all[n];
}

/** Program, argv and env that start `agent`'s ACP server (plus `args`/`env` the agent's auth method adds for a terminal login). */
function launchOf(agent, { claude, args = [], env = {} } = {}) {
  if (agent.builtin) {
    // ELECTRON_RUN_AS_NODE only for the adapter's own process: the launcher drops it before the agent's tools run
    return { file: process.execPath, args: ['-e', LAUNCHER, ADAPTER, ...args], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: claude, CLAUDE_CODE_AUTO_CONNECT_IDE: 'false', CLAUDE_AGENT_ACP_PROTOCOL: 'v1', ...env } };
  }
  return { file: findOnPath(agent.command) || agent.command, args: [...agent.args, ...args], env: { ...process.env, ...agent.env, ...env } };
}

/** The adapter says "sign in" with JSON-RPC -32000 (ACP's auth_required). */
const isAuthError = e => !!e && e.code === -32000 && /auth/i.test(e.message || '');

const timeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

/** Plays a recorded session (test/fixtures/acp/*.jsonl) instead of an agent, for UI work without spending tokens. */
class FixtureAgent {
  constructor(file, handlers) {
    this.h = handlers;
    this.lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(l => l.dir === 'in' || l.dir === 'out');
    this.cancelled = false;
    const reqIdx = method => this.lines.findIndex(l => l.dir === 'out' && l.msg.method === method);
    this.promptAt = reqIdx('session/prompt');
    this.newAt = reqIdx('session/new');
    if (this.promptAt < 0 || this.newAt < 0) throw new Error(`fixture ${path.basename(file)} has no session/new + session/prompt`);
  }

  result(idx) {
    const id = this.lines[idx].msg.id;
    const r = this.lines.find(l => l.dir === 'in' && l.msg.id === id && !l.msg.method);
    return r && r.msg.result;
  }

  async request(method, params) {
    if (method === 'initialize') return this.result(this.lines.findIndex(l => l.dir === 'out' && l.msg.method === 'initialize'));
    if (method === 'session/list') return { sessions: [] };
    if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
      const res = this.result(this.newAt);
      // notifications recorded between session/new and the prompt (commands, mode) arrive right after it
      setTimeout(() => {
        for (const l of this.lines.slice(this.newAt, this.promptAt)) if (l.dir === 'in' && l.msg.method === 'session/update') this.h.notify('session/update', l.msg.params);
      }, 0);
      return res;
    }
    if (method === 'session/prompt') return this.play();
    if (method === 'session/set_config_option') return { configOptions: (this.result(this.newAt).configOptions || []).map(o => (o.id === params.configId ? { ...o, currentValue: params.value } : o)) };
    return {};
  }

  notify(method) { if (method === 'session/cancel') this.cancelled = true; }

  async play() {
    this.cancelled = false;
    const promptId = this.lines[this.promptAt].msg.id;
    let prev = this.lines[this.promptAt].t;
    for (const l of this.lines.slice(this.promptAt + 1)) {
      if (l.dir !== 'in') continue;
      if (this.cancelled) return { stopReason: 'cancelled' };
      const m = l.msg;
      await new Promise(r => setTimeout(r, Math.min(MAX_GAP_MS, Math.max(0, l.t - prev))));
      prev = l.t;
      if (m.id === promptId && !m.method) return m.result;
      if (m.method && m.id !== undefined) await this.h.request(m.method, m.params); // e.g. permission: wait for the UI's answer
      else if (m.method) this.h.notify(m.method, m.params);
    }
    return { stopReason: 'end_turn' };
  }

  close() {}
}

/** One chat tab's ACP session: adapter process, transcript model, working/waiting/idle state. */
class Chat extends EventEmitter {
  /** `agent`: from resolveAgent. `dataDir`: where the adapter's stderr log goes. `saved`: {sessionId, started, title, usage} of a conversation to bring back. */
  constructor({ id, cwd, dataDir, saved, agent }) {
    super();
    this.id = id;
    this.spec = agent || resolveAgent({});
    this.authMethods = [];
    this.caps = null;
    this.terms = null; // client terminals, created on the agent's first terminal/create
    this.termBuf = new Map(); // terminal id -> output waiting for the next flush
    this.termTimer = null;
    this.cwd = cwd;
    this.dataDir = dataDir;
    this.model = emptyModel();
    this.started = !!(saved && saved.started); // a prompt was sent, so the agent has a transcript to load
    this.restore = this.started;
    if (saved) { this.model.title = saved.title || null; this.model.usage = saved.usage || null; } // replay doesn't carry either
    this.seq = 0;
    this.status = 'starting'; // starting | ready | no-claude | no-agent | auth-required | disconnected | error
    this.error = null;
    this.state = 'idle';
    this.turns = 0; // prompts in flight
    this.reqSeq = 0;
    this.pending = new Map(); // reqId -> {resolve}
    this.fileReqs = new Map(); // reqId -> resolve, for unsaved-buffer lookups answered by the renderer
    this.proc = null;
    this.conn = null;
    this.sessionId = (saved && saved.sessionId) || null;
    this.gen = 0; // bumps when the connection is dropped, so turns of the old one don't touch the new one's counters
    this.closed = false;
  }

  get pid() { return this.proc ? this.proc.pid : null; }

  /** Spawn the adapter and open the conversation: a fresh one, or (restore) `session/load`, whose replay rebuilds the transcript. */
  start() { return this.open(this.restore ? 'load' : 'new'); }

  /** mode: 'new' | 'load' (replays the transcript) | 'resume' (no replay). */
  async open(mode) {
    try {
      const fixture = process.env.HARBOR_ACP_FIXTURE;
      if (fixture) this.agent = new FixtureAgent(fixture, { notify: (m, p) => this.onNotify(m, p), request: (m, p) => this.onRequest(m, p) });
      else {
        let claude = null;
        if (this.spec.builtin) {
          claude = findClaude();
          if (!claude) return this.setStatus('no-claude');
        } else if (!findOnPath(this.spec.command)) return this.setStatus('no-agent', `Couldn't find "${this.spec.command}" on your PATH.`);
        this.agent = await this.connect(claude);
      }
      const init = await this.agent.request('initialize', { protocolVersion: 1, clientCapabilities: this.clientCaps(), clientInfo: { name: 'tawny', version: '0.2.0' } });
      this.agentInfo = init.agentInfo || null;
      this.caps = init.agentCapabilities || null;
      this.authMethods = init.authMethods || [];
      let res;
      if (mode === 'new' || !this.sessionId) res = await this.newSession();
      else {
        try { res = await this.agent.request(mode === 'load' ? 'session/load' : 'session/resume', { sessionId: this.sessionId, cwd: this.cwd, mcpServers: [] }); }
        catch (e) {
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
  clientCaps() { return { ...CLIENT_CAPS, terminal: !this.spec.builtin }; }

  async newSession() {
    const ns = await this.agent.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.sessionId = ns.sessionId;
    this.started = false;
    return ns;
  }

  /** `/clear`: a fresh conversation in the same tab; the old one is deleted like on tab close. */
  async clear() {
    if (this.closed || this.status !== 'ready' || this.turns) throw new Error('Wait for the current turn to finish before clearing.');
    const old = this.sessionId;
    const res = await this.newSession();
    if (res && res.configOptions) this.model.configOptions = res.configOptions;
    this.cancelPending();
    this.push({ sessionUpdate: 'x_clear' });
    this.persist();
    if (old) {
      const sc = (this.caps && this.caps.sessionCapabilities) || null;
      const gone = m => Promise.resolve(this.agent.request(m, { sessionId: old })).catch(() => {});
      if (!sc || sc.delete) await timeout(gone('session/delete'), CLOSE_MS);
      if (!sc || sc.close) await timeout(gone('session/close'), CLOSE_MS);
    }
  }

  /** Respawn the adapter after a crash and `session/resume` (no replay: the transcript is still here). */
  async reconnect() {
    if (this.closed || !['disconnected', 'error', 'auth-required', 'no-agent', 'no-claude'].includes(this.status)) return;
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
    try { agent && agent.close(); } catch { /* */ }
    try { proc && proc.kill(); } catch { /* */ }
  }

  /** Tell the owner what to keep across a restart. */
  persist() {
    if (this.sessionId) this.emit('persist', { agent: this.spec.name, sessionId: this.sessionId, cwd: this.cwd, started: this.started, title: this.model.title, usage: this.model.usage });
  }

  async connect(claude) {
    const { client, ndJsonStream, methods } = await loadSdk();
    fs.mkdirSync(path.join(this.dataDir, 'logs'), { recursive: true });
    const logFile = path.join(this.dataDir, 'logs', `acp-${this.id}.log`);
    const log = fs.createWriteStream(logFile);
    const launch = launchOf(this.spec, { claude });
    const proc = this.proc = spawn(launch.file, launch.args, { cwd: this.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'] });
    log.write(`[tawny] spawn pid=${proc.pid} agent=${this.spec.name} ${this.spec.builtin ? `claude=${claude} adapter=${ADAPTER}` : [launch.file, ...launch.args].join(' ')}\n`);
    proc.stderr.pipe(log);
    proc.on('error', e => { if (this.proc === proc) this.lost(`Couldn't start the agent: ${e.message}`); });
    proc.on('exit', (code, sig) => { setTimeout(() => fs.appendFile(logFile, `[tawny] exit code=${code} signal=${sig}\n`, () => {}), 100); if (this.proc === proc) this.lost(`Agent exited (${sig || code})`); });
    // both versions in the log make adapter/claude skew easy to spot
    if (claude) try { log.write(`[tawny] claude ${execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim()}\n`); } catch { /* */ }
    const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const app = client({ name: 'tawny', version: '0.2.0' })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.onRequest('session/request_permission', params))
      .onRequest(methods.client.fs.readTextFile, ({ params }) => this.onRequest('fs/read_text_file', params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => this.onRequest('fs/write_text_file', params))
      .onRequest(methods.client.terminal.create, ({ params }) => this.onRequest('terminal/create', params))
      .onRequest(methods.client.terminal.output, ({ params }) => this.onRequest('terminal/output', params))
      .onRequest(methods.client.terminal.waitForExit, ({ params }) => this.onRequest('terminal/wait_for_exit', params))
      .onRequest(methods.client.terminal.kill, ({ params }) => this.onRequest('terminal/kill', params))
      .onRequest(methods.client.terminal.release, ({ params }) => this.onRequest('terminal/release', params))
      .onNotification(methods.client.session.update, ({ params }) => this.onNotify('session/update', params))
      .onNotification('*', ctx => this.onNotify(ctx.method, ctx.params));
    const conn = this.conn = app.connect(stream);
    return {
      request: (method, params) => conn.agent.request(method, params),
      notify: (method, params) => conn.agent.notify(method, params),
      close: () => { try { conn.close(); } catch { /* */ } },
    };
  }

  /** Adapter went away without us asking. */
  lost(msg) {
    if (this.closed || this.status === 'disconnected') return;
    this.gen++;
    this.closeTerminals();
    this.cancelPending();
    this.turns = 0;
    this.setState();
    this.setStatus('disconnected', msg);
  }

  setStatus(status, error = null) {
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

  push(update) {
    fold(this.model, update);
    this.emit('update', { seq: ++this.seq, update });
    if (update.sessionUpdate === 'session_info_update' || update.sessionUpdate === 'usage_update') this.persist();
  }

  onNotify(method, params) {
    if (method === 'session/update') this.push(params.update);
    else if (method === '_auth/status_update') this.model.auth = params.authStatus ? params.authStatus.label || params.authStatus.kind : null; // never keep the account email
  }

  onRequest(method, params) {
    if (method === 'session/request_permission') return this.askPermission(params);
    if (method === 'fs/read_text_file') return this.readFile(params);
    if (method === 'fs/write_text_file') return F.write(params.path, params.content).then(() => ({}));
    if (method.startsWith('terminal/')) return this.terminalRequest(method, params);
    throw new Error(`unsupported client method ${method}`);
  }

  terminalRequest(method, params) {
    const T = this.terminals();
    switch (method) {
      case 'terminal/create': return T.create({ ...params, cwd: params.cwd || this.cwd });
      case 'terminal/output': return T.output(params.terminalId);
      case 'terminal/wait_for_exit': return T.waitForExit(params.terminalId);
      case 'terminal/kill': T.kill(params.terminalId); return {};
      default: T.release(params.terminalId); return {}; // terminal/release
    }
  }

  terminals() {
    return this.terms || (this.terms = new Terminals({
      cwd: this.cwd,
      onData: (tid, data) => {
        this.termBuf.set(tid, (this.termBuf.get(tid) || '') + data);
        if (!this.termTimer) this.termTimer = setTimeout(() => this.flushTerminals(), TERM_FLUSH_MS);
      },
      onExit: (tid, exit) => { this.flushTerminals(); this.push({ sessionUpdate: 'x_terminal', terminalId: tid, exit }); },
    }));
  }

  /** Terminal output reaches the card in batches, not per pty chunk. */
  flushTerminals() {
    clearTimeout(this.termTimer);
    this.termTimer = null;
    const bufs = [...this.termBuf];
    this.termBuf.clear();
    for (const [terminalId, data] of bufs) this.push({ sessionUpdate: 'x_terminal', terminalId, data });
  }

  closeTerminals() {
    clearTimeout(this.termTimer);
    this.termTimer = null;
    this.termBuf.clear();
    if (this.terms) this.terms.closeAll();
    this.terms = null;
  }

  /** Answer an `agent`-type auth method (the agent handles login itself), then start over. */
  async authenticate(methodId) {
    if (!this.agent) throw new Error('Not connected');
    await this.agent.request('authenticate', { methodId });
    this.setStatus('error', null); // let reconnect() run
    return this.reconnect();
  }

  /** Auth methods for the UI. A terminal method's `run` is the command line to run, in a terminal tab, to log in. */
  authList() {
    return (this.authMethods || []).map(m => ({ id: m.id, name: m.name, description: m.description || null, terminal: m.type === 'terminal' }));
  }

  /** Program + argv + env for a terminal auth method: the agent's own command line with the method's args appended. */
  authLaunch(methodId) {
    const m = (this.authMethods || []).find(x => x.id === methodId && x.type === 'terminal');
    if (!m) throw new Error('No such sign-in method');
    return launchOf(this.spec, { claude: findClaude(), args: m.args || [], env: m.env || {} });
  }

  askPermission(params) {
    const reqId = ++this.reqSeq;
    const req = { reqId, toolCall: params.toolCall, options: params.options };
    return new Promise(resolve => {
      this.pending.set(reqId, { resolve });
      this.model.pending.push(req);
      this.setState();
      this.emit('permission', req);
    });
  }

  /** The renderer's answer: an optionId, or null for cancelled. */
  answer(reqId, optionId) {
    const p = this.pending.get(reqId);
    if (!p) return;
    this.pending.delete(reqId);
    this.model.pending = this.model.pending.filter(r => r.reqId !== reqId);
    p.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
    this.setState();
    this.emit('permission-done', reqId);
  }

  cancelPending() { for (const reqId of [...this.pending.keys()]) this.answer(reqId, null); }

  /** Unsaved text of `file` from the editor, or null (not open, clean, or the renderer didn't answer). */
  askBuffer(file) {
    const reqId = ++this.reqSeq;
    return new Promise(resolve => {
      const t = setTimeout(() => { this.fileReqs.delete(reqId); resolve(null); }, BUFFER_MS);
      this.fileReqs.set(reqId, text => { clearTimeout(t); resolve(text); });
      this.emit('file-request', { reqId, path: file });
    });
  }

  fileReply(reqId, text) {
    const r = this.fileReqs.get(reqId);
    if (!r) return;
    this.fileReqs.delete(reqId);
    r(typeof text === 'string' ? text : null);
  }

  async readFile({ path: file, line, limit }) {
    const dirty = this.listenerCount('file-request') ? await this.askBuffer(file) : null;
    const lines = (dirty != null ? dirty : await fs.promises.readFile(file, 'utf8')).split('\n');
    const from = line ? line - 1 : 0;
    return { content: (limit ? lines.slice(from, from + limit) : lines.slice(from)).join('\n') };
  }

  /** blocks: ACP content blocks. Resolves with the stop reason when the turn ends. */
  async prompt(blocks) {
    if (this.status !== 'ready') throw new Error(`Chat is not ready (${this.status})`);
    const text = blocks.map(b => (b.type === 'text' ? b.text : b.type === 'resource_link' ? `@${b.name}` : b.type === 'image' ? '[image]' : '')).join('');
    this.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text }, messageId: `local-${++this.seq}` });
    this.turns++;
    const gen = this.gen;
    this.setState();
    if (!this.started) { this.started = true; this.persist(); }
    try {
      const res = await this.agent.request('session/prompt', { sessionId: this.sessionId, prompt: blocks });
      return res.stopReason;
    } catch (e) {
      if (isAuthError(e)) this.setStatus('auth-required', e.message);
      else this.push({ sessionUpdate: 'notice', text: e.message || String(e) });
      return 'error';
    } finally {
      if (gen === this.gen) { this.turns--; this.setState(); }
    }
  }

  cancel() {
    if (!this.agent || !this.sessionId) return;
    this.cancelPending();
    try { Promise.resolve(this.agent.notify('session/cancel', { sessionId: this.sessionId })).catch(() => {}); } catch { /* */ }
  }

  async setConfig(configId, value) {
    const res = await this.agent.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    if (res && res.configOptions) this.push({ sessionUpdate: 'config_option_update', configOptions: res.configOptions });
  }

  history() {
    return { seq: this.seq, status: this.status, error: this.error, state: this.state, sessionId: this.sessionId, model: this.model, agent: { name: this.spec.name, label: this.spec.label, builtin: !!this.spec.builtin }, auth: this.authList() };
  }

  /** Tab closed: delete the conversation, like closing a terminal agent deletes its transcript. Quit: just stop (`keep`). */
  async close({ keep = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    this.closeTerminals();
    if (this.agent && this.sessionId && this.status === 'ready' && !keep) {
      const sc = (this.caps && this.caps.sessionCapabilities) || null; // unknown capabilities: try anyway
      if (!sc || sc.delete) await timeout(Promise.resolve(this.agent.request('session/delete', { sessionId: this.sessionId })).catch(() => {}), CLOSE_MS);
      if (!sc || sc.close) await timeout(Promise.resolve(this.agent.request('session/close', { sessionId: this.sessionId })).catch(() => {}), CLOSE_MS);
    }
    try { this.agent && this.agent.close(); } catch { /* */ }
    try { this.proc && this.proc.kill(); } catch { /* */ }
    if (!keep) this.dropTranscript(); // the agent may have been gone (crashed) or not have deleted it
    this.removeAllListeners();
  }

  /** Claude Code's own copy of this conversation: ~/.claude/projects/<cwd, non-alphanumerics -> '-'>/<sessionId>.jsonl (+ a sidecar dir). */
  dropTranscript() {
    if (!this.spec.builtin || !this.started || !/^[\w-]+$/.test(this.sessionId || '') || process.env.HARBOR_ACP_FIXTURE) return; // Claude Code's layout only
    try {
      const dir = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(this.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
      fs.rmSync(path.join(dir, `${this.sessionId}.jsonl`), { force: true });
      fs.rmSync(path.join(dir, this.sessionId), { recursive: true, force: true });
    } catch { /* cwd gone or nothing there */ }
  }

  /** The agent's conversations for `cwd` (history picker), newest first. Spawns a short-lived adapter. */
  static async list(cwd, dataDir, agent) {
    const probe = new Chat({ id: 'list', cwd, dataDir, agent });
    try {
      const fixture = process.env.HARBOR_ACP_FIXTURE;
      if (fixture) return [];
      const claude = probe.spec.builtin ? findClaude() : null;
      if (probe.spec.builtin && !claude) throw new Error('Claude Code is not installed');
      if (!probe.spec.builtin && !findOnPath(probe.spec.command)) throw new Error(`Couldn't find "${probe.spec.command}" on your PATH.`);
      probe.agent = await probe.connect(claude);
      await probe.agent.request('initialize', { protocolVersion: 1, clientCapabilities: probe.clientCaps(), clientInfo: { name: 'tawny', version: '0.2.0' } });
      const res = await probe.agent.request('session/list', { cwd });
      return (res.sessions || []).map(x => ({ sessionId: x.sessionId, title: x.title || null, updatedAt: x.updatedAt || null }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } finally { probe.close({ keep: true }).catch(() => {}); }
  }
}

module.exports = { Chat, findClaude, agentList, resolveAgent, launchOf };
