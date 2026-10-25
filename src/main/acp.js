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

const ADAPTER = path.join(__dirname, '..', '..', 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
// Run the ESM adapter with Electron as node, but drop ELECTRON_RUN_AS_NODE first so it doesn't leak into the agent's shell.
const LAUNCHER = 'delete process.env.ELECTRON_RUN_AS_NODE; import(require("url").pathToFileURL(process.argv[1]).href)';
const CLIENT_CAPS = { fs: { readTextFile: true, writeTextFile: true }, terminal: false, auth: { terminal: true }, _meta: { terminal_output: true } };
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
  /** `dataDir`: where the adapter's stderr log goes. `saved`: {sessionId, started, title, usage} of a conversation to bring back. */
  constructor({ id, cwd, dataDir, saved }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.dataDir = dataDir;
    this.model = emptyModel();
    this.started = !!(saved && saved.started); // a prompt was sent, so the agent has a transcript to load
    this.restore = this.started;
    if (saved) { this.model.title = saved.title || null; this.model.usage = saved.usage || null; } // replay doesn't carry either
    this.seq = 0;
    this.status = 'starting'; // starting | ready | no-claude | auth-required | disconnected | error
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
        const claude = findClaude();
        if (!claude) return this.setStatus('no-claude');
        this.agent = await this.connect(claude);
      }
      const init = await this.agent.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPS, clientInfo: { name: 'tawny', version: '0.2.0' } });
      this.agentInfo = init.agentInfo || null;
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
      if (!this.closed) this.setStatus('error', e.message);
    }
  }

  async newSession() {
    const ns = await this.agent.request('session/new', { cwd: this.cwd, mcpServers: [] });
    this.sessionId = ns.sessionId;
    this.started = false;
    return ns;
  }

  /** Respawn the adapter after a crash and `session/resume` (no replay: the transcript is still here). */
  async reconnect() {
    if (this.closed || (this.status !== 'disconnected' && this.status !== 'error')) return;
    this.drop();
    this.setStatus('starting');
    await this.open(this.started ? 'resume' : 'new');
  }

  /** Let go of the adapter process and connection without closing the chat. */
  drop() {
    this.gen++;
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
    if (this.sessionId) this.emit('persist', { sessionId: this.sessionId, cwd: this.cwd, started: this.started, title: this.model.title, usage: this.model.usage });
  }

  async connect(claude) {
    const { client, ndJsonStream, methods } = await loadSdk();
    fs.mkdirSync(path.join(this.dataDir, 'logs'), { recursive: true });
    const logFile = path.join(this.dataDir, 'logs', `acp-${this.id}.log`);
    const log = fs.createWriteStream(logFile);
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_CODE_EXECUTABLE: claude, CLAUDE_CODE_AUTO_CONNECT_IDE: 'false', CLAUDE_AGENT_ACP_PROTOCOL: 'v1' };
    const proc = this.proc = spawn(process.execPath, ['-e', LAUNCHER, ADAPTER], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    log.write(`[tawny] spawn pid=${proc.pid} claude=${claude} adapter=${ADAPTER}\n`);
    proc.stderr.pipe(log);
    proc.on('error', e => { if (this.proc === proc) this.lost(`Couldn't start the agent: ${e.message}`); });
    proc.on('exit', (code, sig) => { setTimeout(() => fs.appendFile(logFile, `[tawny] exit code=${code} signal=${sig}\n`, () => {}), 100); if (this.proc === proc) this.lost(`Agent exited (${sig || code})`); });
    // both versions in the log make adapter/claude skew easy to spot
    try { log.write(`[tawny] claude ${execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 3000 }).trim()}\n`); } catch { /* */ }
    const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
    const app = client({ name: 'tawny', version: '0.2.0' })
      .onRequest(methods.client.session.requestPermission, ({ params }) => this.onRequest('session/request_permission', params))
      .onRequest(methods.client.fs.readTextFile, ({ params }) => this.onRequest('fs/read_text_file', params))
      .onRequest(methods.client.fs.writeTextFile, ({ params }) => this.onRequest('fs/write_text_file', params))
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
    this.cancelPending();
    this.turns = 0;
    this.setState();
    this.setStatus('disconnected', msg);
  }

  setStatus(status, error = null) {
    this.status = status;
    this.error = error;
    this.emit('status', { status, error });
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
    throw new Error(`unsupported client method ${method}`);
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
      if (e && e.code === -32000 && /auth/i.test(e.message)) this.setStatus('auth-required', e.message);
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

  history() { return { seq: this.seq, status: this.status, error: this.error, state: this.state, sessionId: this.sessionId, model: this.model }; }

  /** Tab closed: delete the conversation, like closing a terminal agent deletes its transcript. Quit: just stop (`keep`). */
  async close({ keep = false } = {}) {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending();
    if (this.agent && this.sessionId && this.status === 'ready' && !keep) {
      await timeout(Promise.resolve(this.agent.request('session/delete', { sessionId: this.sessionId })).catch(() => {}), CLOSE_MS);
      await timeout(Promise.resolve(this.agent.request('session/close', { sessionId: this.sessionId })).catch(() => {}), CLOSE_MS);
    }
    try { this.agent && this.agent.close(); } catch { /* */ }
    try { this.proc && this.proc.kill(); } catch { /* */ }
    if (!keep) this.dropTranscript(); // the agent may have been gone (crashed) or not have deleted it
    this.removeAllListeners();
  }

  /** Claude Code's own copy of this conversation: ~/.claude/projects/<cwd, non-alphanumerics -> '-'>/<sessionId>.jsonl (+ a sidecar dir). */
  dropTranscript() {
    if (!this.started || !/^[\w-]+$/.test(this.sessionId || '') || process.env.HARBOR_ACP_FIXTURE) return;
    try {
      const dir = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(this.cwd).replace(/[^a-zA-Z0-9]/g, '-'));
      fs.rmSync(path.join(dir, `${this.sessionId}.jsonl`), { force: true });
      fs.rmSync(path.join(dir, this.sessionId), { recursive: true, force: true });
    } catch { /* cwd gone or nothing there */ }
  }

  /** The agent's conversations for `cwd` (history picker), newest first. Spawns a short-lived adapter. */
  static async list(cwd, dataDir) {
    const probe = new Chat({ id: 'list', cwd, dataDir });
    try {
      const fixture = process.env.HARBOR_ACP_FIXTURE;
      if (fixture) return [];
      const claude = findClaude();
      if (!claude) throw new Error('Claude Code is not installed');
      probe.agent = await probe.connect(claude);
      await probe.agent.request('initialize', { protocolVersion: 1, clientCapabilities: CLIENT_CAPS, clientInfo: { name: 'tawny', version: '0.2.0' } });
      const res = await probe.agent.request('session/list', { cwd });
      return (res.sessions || []).map(x => ({ sessionId: x.sessionId, title: x.title || null, updatedAt: x.updatedAt || null }))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    } finally { probe.close({ keep: true }).catch(() => {}); }
  }
}

module.exports = { Chat, findClaude };
