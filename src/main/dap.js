'use strict';
// Debug Adapter Protocol host: one Session per debug launch, each owning an adapter process and one or more DAP connections.
// The renderer drives it (start/request/setBreakpoints/stop); every adapter event is pushed back tagged with (sid, cid).
//   node  → Microsoft's js-debug (vendor/js-debug, see scripts/fetch-js-debug.js). It debugs child processes by sending
//           `startDebugging`; each of those becomes another connection to the same server, so cid distinguishes them.
//   rdbg  → the Ruby `debug` gem: `rdbg --open=vscode` serves DAP over TCP.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const fs = require('fs');
const path = require('path');

const JS_DEBUG = path.join(__dirname, '..', '..', 'vendor', 'js-debug', 'src', 'dapDebugServer.js')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// ---------------------------------------------------------------- launch.json

/** Strips // and block comments plus trailing commas (launch.json is JSONC), leaving string contents alone. */
function parseJsonc(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const NODE_TYPES = new Set(['node', 'pwa-node']);
const RUBY_TYPES = new Set(['rdbg']);
const supported = c => c && (NODE_TYPES.has(c.type) || RUBY_TYPES.has(c.type)) && (c.request === 'launch' || c.request === 'attach');

/** Launch configurations for a worktree: .vscode/launch.json plus a "run current file" entry when the file is runnable. */
function configs(root, activeFile) {
  const list = [];
  try {
    const j = parseJsonc(fs.readFileSync(path.join(root, '.vscode', 'launch.json'), 'utf8'));
    for (const c of j.configurations || []) if (supported(c)) list.push(c);
  } catch { /* no launch.json */ }
  if (activeFile && /\.(c|m)?js$/.test(activeFile)) {
    list.push({ type: 'pwa-node', request: 'launch', name: `Run ${path.basename(activeFile)} (Node)`, program: activeFile, cwd: root, implicit: true });
  } else if (activeFile && /\.rb$/.test(activeFile)) {
    list.push({ type: 'rdbg', request: 'launch', name: `Run ${path.basename(activeFile)} (Ruby)`, script: `ruby ${shellQuote(activeFile)}`, cwd: root, implicit: true });
  }
  return list;
}

const shellQuote = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function shellSplit(s) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|((?:\\.|[^\s"'\\])+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3].replace(/\\(.)/g, '$1'));
  return out;
}

/** ${workspaceFolder}, ${file}, ${env:X} … in every string of a configuration. */
function substitute(value, ctx) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (all, name) => {
      switch (name) {
        case 'workspaceFolder': case 'cwd': return ctx.root;
        case 'workspaceFolderBasename': return path.basename(ctx.root);
        case 'pathSeparator': case '/': return path.sep;
        case 'file': return ctx.file || all;
        case 'fileBasename': return ctx.file ? path.basename(ctx.file) : all;
        case 'fileDirname': return ctx.file ? path.dirname(ctx.file) : all;
        case 'fileBasenameNoExtension': return ctx.file ? path.basename(ctx.file, path.extname(ctx.file)) : all;
        case 'relativeFile': return ctx.file ? path.relative(ctx.root, ctx.file) : all;
        default:
          if (name.startsWith('env:')) return process.env[name.slice(4)] || '';
          return all;
      }
    });
  }
  if (Array.isArray(value)) return value.map(v => substitute(v, ctx));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, ctx)]));
  return value;
}

// ---------------------------------------------------------------- one DAP connection

class Conn extends EventEmitter {
  constructor(id, socket) {
    super();
    this.id = id; this.socket = socket; this.buf = Buffer.alloc(0);
    this.seq = 1; this.pending = new Map();
    this.ready = false; this.caps = {};
    socket.on('data', d => this.onData(d));
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('debug adapter disconnected'));
      this.pending.clear();
      this.emit('close');
    });
    socket.on('error', () => { /* close follows */ });
  }

  send(msg) {
    if (this.socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.socket.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.socket.write(body);
  }

  request(command, args, timeout = 30000) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(seq); reject(new Error(`${command} timed out`)); }, timeout);
      this.pending.set(seq, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      this.send({ seq, type: 'request', command, arguments: args });
    });
  }

  respond(req, body, error) {
    this.send({ seq: this.seq++, type: 'response', request_seq: req.seq, command: req.command, success: !error, ...(error ? { message: error } : { body: body || {} }) });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const m = /Content-Length:\s*(\d+)/i.exec(this.buf.slice(0, sep).toString('ascii'));
      if (!m) { this.buf = this.buf.slice(sep + 4); continue; }
      const len = Number(m[1]);
      if (this.buf.length < sep + 4 + len) return;
      const body = this.buf.slice(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.slice(sep + 4 + len);
      let msg;
      try { msg = JSON.parse(body); } catch { continue; }
      this.dispatch(msg);
    }
  }

  dispatch(msg) {
    if (msg.type === 'response') {
      const p = this.pending.get(msg.request_seq);
      if (!p) return;
      this.pending.delete(msg.request_seq);
      msg.success ? p.resolve(msg.body || {}) : p.reject(new Error(msg.message || `${msg.command} failed`));
    } else if (msg.type === 'event') {
      this.emit('event', msg);
      this.emit(`event:${msg.event}`, msg.body);
    } else if (msg.type === 'request') {
      this.emit('reverse', msg);
    }
  }

  close() { this.socket.destroy(); }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function connect(port, alive, timeout = 20000) {
  const deadline = Date.now() + timeout;
  const attempt = () => new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  return (async () => {
    for (;;) {
      try { return await attempt(); } catch (e) {
        if (!alive() || Date.now() > deadline) throw new Error(`could not connect to the debug adapter on port ${port}`);
        await wait(150);
      }
    }
  })();
}

// ---------------------------------------------------------------- one debug session

class Session extends EventEmitter {
  constructor(sid, root, config, breakpoints) {
    super();
    this.sid = sid; this.root = root; this.config = config;
    this.bps = new Map(Object.entries(breakpoints || {}));   // path -> [{ line, condition?, logMessage? }]
    this.conns = new Map(); this.nextCid = 1;
    this.ended = false;
  }

  /** Spawns the adapter, opens the root connection and runs the DAP handshake. */
  async start() {
    const c = this.config;
    if (NODE_TYPES.has(c.type)) {
      if (!fs.existsSync(JS_DEBUG)) throw new Error('js-debug is not installed — run `npm run fetch:js-debug` in the Harbor folder.');
      this.adapterId = 'pwa-node';
      this.proc = spawn(process.execPath, [JS_DEBUG, '0', '127.0.0.1'], {
        cwd: this.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      this.port = await new Promise((resolve, reject) => {
        let out = '';
        this.proc.stdout.on('data', d => { out += d; const m = /listening at [\d.]+:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
        this.proc.stderr.on('data', d => this.output('stderr', String(d)));
        this.proc.on('error', reject);
        this.proc.on('exit', code => reject(new Error(`js-debug exited (code ${code})`)));
      });
      const launch = { ...c, type: 'pwa-node', cwd: c.cwd || this.root, console: 'internalConsole' };
      delete launch.implicit;
      return this.addConnection({ command: c.request, arguments: launch });
    }
    // Ruby: start the debuggee under rdbg, then attach over TCP
    this.adapterId = 'rdbg';
    this.port = await freePort();
    if (c.request === 'launch') {
      if (!c.script) throw new Error('rdbg launch configuration needs a "script" (e.g. "bin/rails s")');
      const rdbg = c.rdbgPath || 'rdbg';
      // plain --open (not --open=vscode, which launches VS Code); rdbg detects DAP clients by their first bytes
      const argv = ['--open', '--host', '127.0.0.1', '--port', String(this.port), '-c', '--', ...shellSplit(c.script), ...(c.args || [])];
      this.proc = spawn(rdbg, argv, {
        cwd: c.cwd || this.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(c.env || {}) },
      });
      this.proc.stdout.on('data', d => this.output('stdout', String(d)));
      this.proc.stderr.on('data', d => this.output('stderr', String(d)));
      const dead = new Promise((_, reject) => {
        this.proc.on('error', e => reject(new Error(e.code === 'ENOENT' ? 'rdbg not found — gem install debug' : e.message)));
        this.proc.on('exit', code => { if (!this.ended) reject(new Error(`rdbg exited (code ${code})`)); });
      });
      dead.catch(() => {});
      this.exited = dead;
    } else {
      this.port = Number(c.port || 12345);
    }
    const alive = () => !this.proc || this.proc.exitCode === null;
    const sock = await Promise.race([connect(this.port, alive, 30000), this.exited || new Promise(() => {})]);
    // `launch` = we started rdbg ourselves on this machine (it then runs without stopping at entry); `attach` honours localfs / localfsMap
    const args = c.request === 'launch'
      ? { type: 'rdbg', request: 'launch', name: c.name, localfs: true }
      : { type: 'rdbg', request: 'attach', name: c.name, localfs: c.localfsMap || c.localfs !== false, nonstop: !!c.nonstop };
    return this.addConnection({ command: c.request, arguments: args }, null, sock);
  }

  output(category, text) { this.emit('event', { cid: 0, event: 'output', body: { category, output: text } }); }

  async addConnection(startReq, _parent, existingSocket) {
    const socket = existingSocket || await connect(this.port, () => !this.ended);
    const conn = new Conn(this.nextCid++, socket);
    const isRoot = this.conns.size === 0;
    conn.isRoot = isRoot;
    this.conns.set(conn.id, conn);
    conn.on('event', e => this.onEvent(conn, e));
    conn.on('reverse', r => this.onReverse(conn, r));
    conn.on('close', () => {
      this.conns.delete(conn.id);
      this.emit('event', { cid: conn.id, event: 'harbor:connClosed', body: {} });
      if (isRoot) this.end();
    });
    await this.handshake(conn, startReq);
    return conn;
  }

  async handshake(conn, startReq) {
    const initialized = new Promise(r => conn.once('event:initialized', r));
    conn.caps = await conn.request('initialize', {
      clientID: 'harbor', clientName: 'Harbor', adapterID: this.adapterId, locale: 'en',
      pathFormat: 'path', linesStartAt1: true, columnsStartAt1: true,
      supportsVariableType: true, supportsStartDebuggingRequest: true, supportsRunInTerminalRequest: false,
    });
    const started = conn.request(startReq.command, startReq.arguments, 180000);
    started.catch(() => {});
    await Promise.race([initialized, started]);
    const bound = await this.sendBreakpoints(conn);
    // js-debug's root connection only holds provisional ("unbound") answers; the child that owns the target gives the real ones
    if (!(this.adapterId === 'pwa-node' && conn.isRoot)) this.emit('event', { cid: conn.id, event: 'harbor:breakpoints', body: { results: bound } });
    const filters = (conn.caps.exceptionBreakpointFilters || []).filter(f => f.default).map(f => f.filter);
    await conn.request('setExceptionBreakpoints', { filters }).catch(() => {});
    if (conn.caps.supportsConfigurationDoneRequest) await conn.request('configurationDone');
    conn.ready = true;
    this.emit('event', { cid: conn.id, event: 'harbor:started', body: { root: conn.isRoot } });
    await started;
  }

  async sendBreakpoints(conn, only) {
    const results = {};
    for (const [file, list] of this.bps) {
      if (only && file !== only) continue;
      try {
        const r = await conn.request('setBreakpoints', {
          source: { path: file }, breakpoints: list.map(b => ({ line: b.line, condition: b.condition || undefined, logMessage: b.logMessage || undefined })),
          lines: list.map(b => b.line),
        });
        results[file] = r.breakpoints || [];
      } catch { results[file] = []; }
    }
    return results;
  }

  /** Replace the breakpoints of one file; returns the adapter's verdict (one entry per breakpoint, in order). */
  async setBreakpoints(file, list) {
    list.length ? this.bps.set(file, list) : this.bps.delete(file);
    let result = [];
    for (const conn of this.conns.values()) {
      if (!conn.ready) continue;
      const r = await this.sendBreakpoints(conn, file);
      result = (r[file] && r[file].length) ? r[file] : result;
    }
    return result;
  }

  onEvent(conn, e) {
    this.emit('event', { cid: conn.id, event: e.event, body: e.body });
    if (e.event === 'terminated') {
      // js-debug reports each target's end on its own connection; close it, the root ending ends the session
      setTimeout(() => {
        if (conn.isRoot || this.conns.size <= 1) this.stop();
        else conn.request('disconnect', {}, 2000).catch(() => {}).then(() => conn.close());
      }, 100);
    }
  }

  onReverse(conn, req) {
    if (req.command === 'startDebugging') {
      const { request, configuration } = req.arguments || {};
      conn.respond(req, {});
      this.addConnection({ command: request || 'attach', arguments: configuration }).catch(e => this.output('stderr', `Child debug session failed: ${e.message}\n`));
    } else {
      conn.respond(req, null, `${req.command} is not supported`);
    }
  }

  request(cid, command, args) {
    const conn = this.conns.get(cid) || [...this.conns.values()].find(c => c.ready);
    if (!conn) return Promise.reject(new Error('debug session is not running'));
    return conn.request(command, args, 60000);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    setTimeout(() => { try { this.proc && this.proc.kill(); } catch { /* */ } }, 300);
    this.emit('end');
  }

  async stop() {
    if (this.ended) return;
    const conns = [...this.conns.values()].reverse();   // children first
    await Promise.all(conns.map(c => c.request('disconnect', { terminateDebuggee: this.config.request !== 'attach' }, 2000).catch(() => {})));
    this.end();
  }
}

// ---------------------------------------------------------------- manager

class Dap extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.nextSid = 1;
  }

  configs(root, activeFile) { return configs(root, activeFile); }

  /** Starts a session in the background; progress and failures arrive as events (harbor:started / harbor:error / harbor:ended). */
  start(root, config, ctx, breakpoints) {
    const sid = this.nextSid++;
    const resolved = substitute(config, { root, file: ctx && ctx.file });
    const s = new Session(sid, root, resolved, breakpoints);
    this.sessions.set(sid, s);
    const emit = e => this.emit('event', { sid, ...e });
    s.on('event', emit);
    s.on('end', () => { this.sessions.delete(sid); emit({ cid: 0, event: 'harbor:ended', body: {} }); });
    s.start().catch(e => {
      emit({ cid: 0, event: 'harbor:error', body: { message: e.message } });
      s.end();
    });
    return { sid, name: resolved.name, root };
  }

  request(sid, cid, command, args) {
    const s = this.sessions.get(sid);
    return s ? s.request(cid, command, args) : Promise.reject(new Error('debug session ended'));
  }

  async setBreakpoints(sid, file, list) {
    const s = this.sessions.get(sid);
    return s ? s.setBreakpoints(file, list) : [];
  }

  stop(sid) { const s = this.sessions.get(sid); return s ? s.stop() : undefined; }
  stopRoot(root) { for (const s of this.sessions.values()) if (s.root === root) s.stop(); }
  /** Window reload or quit: the renderer that owned the sessions is gone. */
  dispose() { for (const s of this.sessions.values()) s.stop(); }
}

module.exports = { Dap, configs, parseJsonc };
