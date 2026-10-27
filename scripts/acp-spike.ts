// Phase 0 spike for chat tabs: drive the Claude ACP adapter as a client and record every JSON-RPC
// message to test/fixtures/acp/*.jsonl (one line per message: {t, dir:'out'|'in'|'meta', ...}).
//   node scripts/acp-spike.ts [--scenario basic|load|init|all] [--node] [--fixtures <dir>]
//   basic: initialize, session/new, one prompt (read + edit + shell) -> claude-basic.jsonl
//   load:  respawn the adapter, session/load the basic session (replay) -> claude-load.jsonl (needs basic first)
//   init:  initialize without the auth.terminal client capability -> claude-init-plain.jsonl
//   all (default): basic then load.
//   --mode <id>: switch the session mode after session/new (e.g. default, so permission requests appear) and write claude-basic-<id>.jsonl.
//   --electron <bin> / --adapter <index.js>: use another Electron binary / adapter entry (e.g. a packaged app's app.asar.unpacked).
//   --no-claude: leave CLAUDE_CODE_EXECUTABLE unset, so the SDK's bundled claude binary runs.
//   --unset-electron-env: start the adapter via `-e` so ELECTRON_RUN_AS_NODE is deleted before it spawns claude (else the agent's shell inherits it).
//   --env-check: use a prompt that prints the ELECTRON*/CLAUDE* env seen by the agent's Bash tool.
//   --node: run the adapter with plain `node` instead of Electron's binary (ELECTRON_RUN_AS_NODE).
// Fixtures are scrubbed: emails -> user@example.com, available_commands_update trimmed to 5 commands.
// Env passed to the adapter: CLAUDE_CODE_EXECUTABLE = `claude` from PATH (else the bundled one).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

// biome-ignore lint/suspicious/noExplicitAny: ACP messages are logged verbatim, whatever their shape
type Any = any;

const ROOT = path.join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (n: string, d: Any): Any => { const i = args.indexOf('--' + n); return i < 0 ? d : (args[i + 1] || true); };
const ADAPTER = opt('adapter', path.join(ROOT, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'));
const useNode = args.includes('--node');
const scenario = opt('scenario', 'all');
const mode = opt('mode', null);
const fixDir = path.resolve(opt('fixtures', path.join(ROOT, 'test/fixtures/acp')));
const electronBin = args.includes('--node') ? null : opt('electron', null) || createRequire(import.meta.url)('electron'); // path to the Electron binary
const stateFile = path.join(os.tmpdir(), 'acp-spike-state.json'); // basic -> load handoff

const PROMPT = args.includes('--env-check') ? 'Run exactly this in the shell and reply with only its output, or "none": env | grep -E "^(ELECTRON|CLAUDE_CODE_EXECUTABLE)" ; true' : 'Do exactly these 3 steps with tools, no extra commentary: 1) read notes.txt 2) edit notes.txt, replacing "world" with "acp" 3) run `ls -la` in the shell. Then reply "done" in one word.';

function findClaude() {
  try { return execFileSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

function makeLog(file: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const t0 = Date.now();
  const log = (dir: string, msg: Any) => {
    const u = msg && msg.params && msg.params.update;
    if (u && u.sessionUpdate === 'available_commands_update' && u.availableCommands.length > 5) {
      msg = { ...msg, params: { ...msg.params, update: { ...u, availableCommands: u.availableCommands.slice(0, 5), _trimmedFrom: u.availableCommands.length } } };
    }
    const line = JSON.stringify({ t: Date.now() - t0, dir, ...(dir === 'meta' ? msg : { msg }) }).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, 'user@example.com');
    fs.appendFileSync(file, line + '\n');
  };
  return { log, t0, now: () => Date.now() - t0 };
}

// Wrap a message stream so every message in both directions is logged.
function tap(stream: Any, log: (dir: string, msg: Any) => void) {
  const rd = stream.readable.pipeThrough(new TransformStream({ transform(m, c) { log('in', m); c.enqueue(m); } }));
  const ts = new TransformStream({ transform(m, c) { log('out', m); c.enqueue(m); } });
  ts.readable.pipeTo(stream.writable).catch(() => {});
  return { readable: rd, writable: ts.writable };
}

function spawnAdapter(cwd: string, log: (dir: string, msg: Any) => void) {
  const claude = args.includes('--no-claude') ? null : findClaude();
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_AUTO_CONNECT_IDE: 'false', CLAUDE_AGENT_ACP_PROTOCOL: 'v1' };
  if (claude) env.CLAUDE_CODE_EXECUTABLE = claude;
  let cmd: string = process.execPath;
  if (!useNode) { cmd = electronBin as string; env.ELECTRON_RUN_AS_NODE = '1'; }
  const argv = args.includes('--unset-electron-env')
    ? ['-e', 'delete process.env.ELECTRON_RUN_AS_NODE; import(require("url").pathToFileURL(process.argv[1]).href)', ADAPTER]
    : [ADAPTER];
  const child = spawn(cmd, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', (d: Buffer) => log('meta', { event: 'stderr', text: d.toString().slice(0, 2000) }));
  child.on('exit', (code: number | null, sig: string | null) => log('meta', { event: 'exit', code, sig }));
  log('meta', { event: 'spawn', cmd, electronAsNode: !useNode, claude: claude || '(bundled)', pid: child.pid });
  return child;
}

async function run(name: string, file: string, cwd: string, fn: (a: Any) => Promise<Any>) {
  const { client, ndJsonStream, methods } = await import('@agentclientprotocol/sdk');
  const { log, now } = makeLog(file);
  const timings: Record<string, number> = {};
  let spawnT = 0; // timings are ms since spawn
  const mark = (k: string) => { timings[k] = now() - spawnT; log('meta', { event: 'timing', name: k, ms: timings[k] }); };
  const child = spawnAdapter(cwd, log);
  spawnT = now();
  const raw = ndJsonStream(Writable.toWeb(child.stdin) as Any, Readable.toWeb(child.stdout) as Any);
  let sawUpdate = false;
  const stream = tap(raw, (dir: string, m: Any) => {
    log(dir, m);
    if (dir === 'in' && m.method === 'session/update' && !sawUpdate) { sawUpdate = true; mark('firstUpdate'); }
  });
  const fsCalls: Any[] = [],
    perms: Any[] = [];
  const app = client({ name: 'tawny-spike', version: '0.0.0' } as Any)
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      const opt = params.options.find(o => o.kind === 'allow_once') || params.options[0];
      perms.push({ tool: params.toolCall.title, kind: params.toolCall.kind, options: params.options.map(o => o.kind + ':' + o.optionId), picked: opt.optionId });
      console.log('permission ->', opt.optionId, '|', params.toolCall.title);
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    })
    .onRequest(methods.client.fs.readTextFile, async ({ params }) => {
      fsCalls.push({ method: 'read', path: params.path });
      const lines = fs.readFileSync(params.path, 'utf8').split('\n');
      const from = params.line ? params.line - 1 : 0;
      return { content: (params.limit ? lines.slice(from, from + params.limit) : lines.slice(from)).join('\n') };
    })
    .onRequest(methods.client.fs.writeTextFile, async ({ params }) => {
      fsCalls.push({ method: 'write', path: params.path });
      fs.writeFileSync(params.path, params.content);
      return {};
    })
    .onNotification(methods.client.session.update, ({ params }) => {
      const u: Any = params.update;
      if (u.sessionUpdate !== 'agent_message_chunk' && u.sessionUpdate !== 'agent_thought_chunk') console.log('update:', u.sessionUpdate, u.title || u.status || '');
    });
  let result;
  try {
    result = await app.connectWith(stream, ctx => fn({ ctx, methods, mark, timings }));
  } finally {
    log('meta', { event: 'summary', timings, fsCalls, perms });
    child.kill();
  }
  return { result, timings, fsCalls, perms };
}

// _meta.terminal_output makes the adapter attach display-terminal data (terminal_info/output/exit) to Bash tool calls.
const caps = (full: boolean) => ({ fs: { readTextFile: true, writeTextFile: true }, terminal: false, ...(full ? { auth: { terminal: true }, _meta: { terminal_output: true } } : {}) });
const init = (ctx: Any, methods: Any, full: boolean) => ctx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: caps(full), clientInfo: { name: 'tawny-spike', version: '0.0.0' } });

async function basic() {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-spike-')));
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'hello world\n');
  const out = await run('basic', path.join(fixDir, mode ? `claude-basic-${mode}.jsonl` : 'claude-basic.jsonl'), cwd, async ({ ctx, methods, mark }: Any) => {
    const ir = await init(ctx, methods, true); mark('initialize');
    const ns = await ctx.request(methods.agent.session.new, { cwd, mcpServers: [] }); mark('session/new');
    console.log('sessionId', ns.sessionId);
    if (mode) { await ctx.request(methods.agent.session.setConfigOption, { sessionId: ns.sessionId, configId: 'mode', value: mode }); mark('setMode'); }
    const pr = await ctx.request(methods.agent.session.prompt, { sessionId: ns.sessionId, prompt: [{ type: 'text', text: PROMPT }] }); mark('stop');
    console.log('stopReason', pr.stopReason);
    return { init: ir, sessionId: ns.sessionId, stopReason: pr.stopReason };
  });
  console.log('notes.txt after:', JSON.stringify(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8')));
  fs.writeFileSync(stateFile, JSON.stringify({ cwd, sessionId: out.result.sessionId }));
  return out;
}

async function load() {
  const { cwd, sessionId } = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return run('load', path.join(fixDir, 'claude-load.jsonl'), cwd, async ({ ctx, methods, mark }: Any) => {
    await init(ctx, methods, true); mark('initialize');
    const lr = await ctx.request(methods.agent.session.load, { sessionId, cwd, mcpServers: [] }); mark('session/load');
    const ls = await ctx.request(methods.agent.session.list, { cwd }); mark('session/list');
    return { load: lr, list: ls };
  });
}

async function initOnly() {
  return run('init', path.join(fixDir, 'claude-init-plain.jsonl'), os.tmpdir(), async ({ ctx, methods, mark }: Any) => {
    const ir = await init(ctx, methods, false); mark('initialize');
    return ir;
  });
}

(async () => {
  const s = scenario;
  const out: Record<string, Any> = {};
  if (s === 'basic' || s === 'all') out.basic = await basic();
  if (s === 'load' || s === 'all') out.load = await load();
  if (s === 'init') out.init = await initOnly();
  for (const [k, v] of Object.entries(out)) console.log(k, JSON.stringify({ timings: v.timings, fsCalls: v.fsCalls, perms: v.perms }));
  process.exit(0);
})().catch(e => { console.error('spike failed:', e); process.exit(1); });
