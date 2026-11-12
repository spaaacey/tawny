// `tawny` CLI client, run with Electron as Node (ELECTRON_RUN_AS_NODE) via the shim in <userData>/bin.
// Stateless: asks the running app for its command schema (`cli.schema`), parses argv against it, sends one request
// over the app's unix socket and prints the reply. See docs/tawny-cli.md.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

interface Schema {
  name: string;
  summary: string;
  params: { properties?: Record<string, Prop>; required?: string[] };
  /** params that may be given positionally, in order */
  args?: string[];
  /** param read from piped stdin (heredoc) when no flag gives it */
  stdin?: string;
}
interface Prop {
  type?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

const die = (msg: string): never => {
  process.stderr.write(`tawny: ${msg}\n`);
  process.exit(1);
};
const kebab = (s: string) => s.replace(/_/g, '-');

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** TAWNY_SOCKET, else the running app's runtime.json (a dead pid means a stale file). */
function findSocket(): string {
  if (process.env.TAWNY_SOCKET) return process.env.TAWNY_SOCKET;
  const dirs = [
    process.env.TAWNY_USER_DATA,
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Tawny')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Tawny'),
  ];
  for (const d of dirs) {
    if (!d) continue;
    try {
      const r = JSON.parse(fs.readFileSync(path.join(d, 'runtime.json'), 'utf8'));
      if (r.socket && alive(r.pid)) return r.socket;
    } catch {
      /* next */
    }
  }
  return die('cannot connect: Tawny is not running (or set TAWNY_SOCKET)');
}

function request(socket: string, method: string, params: unknown): Promise<unknown> {
  const ctx = { chatId: process.env.TAWNY_CHAT_ID, worktree: process.env.TAWNY_WORKTREE };
  return new Promise((resolve, reject) => {
    const c = net.connect(socket);
    let buf = '';
    c.on('connect', () => c.write(`${JSON.stringify({ method, params, ctx })}\n`));
    c.on('data', (d) => {
      buf += d;
      if (!buf.includes('\n')) return;
      c.end();
      try {
        const r = JSON.parse(buf);
        if (r.error) reject(new Error(r.error));
        else resolve(r.result);
      } catch (e) {
        reject(e);
      }
    });
    c.on('error', (e) => reject(new Error(`cannot connect: ${e.message}`)));
  });
}

function help(schema: Schema[], words: string[]): string {
  const cmd = (m: Schema) => `tawny ${m.name.replace('.', ' ').replace(/_/g, '-')}`;
  const first = (s: string) => s.split(/(?<=\.)\s/)[0];
  const group = schema.filter((m) => words.length && m.name.startsWith(`${words[0].replace(/-/g, '_')}.`));
  const exact = schema.find((m) => m.name === words.join('.').replace(/-/g, '_'));
  if (exact) {
    const props = exact.params.properties ?? {};
    const usage = [cmd(exact), ...(exact.args ?? []).map((a) => `[<${kebab(a)}>]`)];
    if (exact.stdin) usage.push(`[<<'EOF' ${kebab(exact.stdin)} EOF]`);
    const lines = [`${usage.join(' ')}\n  ${exact.summary}\n`];
    for (const [k, p] of Object.entries(props)) {
      const type = p.enum ? p.enum.join('|') : p.type === 'string' ? 'text' : (p.type ?? '');
      const req = exact.params.required?.includes(k) ? ' (required)' : '';
      lines.push(`  --${kebab(k)} <${type}>${req}  ${p.description ?? ''}`);
      if (p.type === 'string') lines.push(`  --${kebab(k)}-file <file|->  same, read from a file or stdin`);
    }
    lines.push('\n  --text  human-readable output');
    return lines.join('\n');
  }
  const list = group.length ? group : schema;
  return [
    group.length ? `tawny ${words[0]} <command>\n` : 'tawny <command> [flags]\n',
    ...list.map((m) => `  ${cmd(m).padEnd(34)} ${first(m.summary)}`),
    group.length ? '' : `  ${'tawny agent-context'.padEnd(34)} Print the command schema as JSON`,
    '\nRun `tawny <command> --help` for flags. JSON output by default; --text for human text.',
  ].join('\n');
}

/** Piped stdin (a heredoc or a file), or undefined for a terminal, /dev/null or nothing arriving: never blocks on a pipe nobody writes to. */
function readStdin(): Promise<string | undefined> {
  let st: fs.Stats;
  try {
    st = fs.fstatSync(0);
  } catch {
    return Promise.resolve(undefined);
  }
  if (st.isFile()) return Promise.resolve(fs.readFileSync(0, 'utf8'));
  if (!st.isFIFO()) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let buf = '';
    const done = (v: string | undefined) => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      process.stdin.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(buf || undefined), 1000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
    });
    process.stdin.on('end', () => done(buf));
    process.stdin.on('error', () => done(undefined));
  });
}

function readSource(v: string) {
  const s = v === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(v, 'utf8');
  return s.replace(/\r?\n$/, '');
}

async function main() {
  const argv = process.argv.slice(2);
  const text = argv.includes('--text');
  const wantHelp = argv.some((a) => a === '--help' || a === '-h') || argv.length === 0 || argv[0] === 'help';
  const rest = argv.filter((a) => a !== '--text' && a !== '--help' && a !== '-h' && a !== 'help');
  const socket = findSocket();
  const schema = (await request(socket, 'cli.schema', {})) as Schema[];

  if (rest[0] === 'agent-context') return print(schema, text);

  // longest command prefix: `pr propose-comment` or `status`
  const names = new Set(schema.map((m) => m.name));
  let words = rest.slice(0, 2).filter((w) => !w.startsWith('--'));
  while (words.length && !names.has(words.join('.').replace(/-/g, '_'))) words = words.slice(0, -1);
  if (wantHelp || !words.length) {
    if (!wantHelp) process.stderr.write(`tawny: unknown command "${rest.join(' ')}"\n`);
    process.stdout.write(`${help(schema, wantHelp ? rest.filter((w) => !w.startsWith('--')) : [])}\n`);
    process.exit(wantHelp ? 0 : 1);
  }
  const method = words.join('.').replace(/-/g, '_');
  const spec = schema.find((m) => m.name === method);
  const props = spec?.params.properties ?? {};
  const params: Record<string, unknown> = {};
  const flags = rest.slice(words.length);
  const positional = [...(spec?.args ?? [])];
  for (let i = 0; i < flags.length; i++) {
    const m = /^--([\w-]+?)(?:=([\s\S]*))?$/.exec(flags[i]);
    if (!m) {
      const name = positional.shift();
      if (!name || flags[i].startsWith('-')) return die(`unexpected argument "${flags[i]}"`);
      params[name] = props[name]?.type === 'integer' || props[name]?.type === 'number' ? Number(flags[i]) : flags[i];
      continue;
    }
    let name = m[1].replace(/-/g, '_');
    const file = !(name in props) && name.endsWith('_file');
    if (file) name = name.slice(0, -5);
    const prop = props[name];
    if (!prop) return die(`unknown flag --${m[1]} (see tawny ${words.join(' ')} --help)`);
    if (prop.type === 'boolean' && !file) {
      params[name] = m[2] === undefined ? true : m[2] !== 'false';
      continue;
    }
    const raw = m[2] ?? flags[++i];
    if (raw === undefined) return die(`--${m[1]} needs a value`);
    const val = file ? readSource(raw) : raw;
    if (prop.type === 'integer' || prop.type === 'number') {
      const n = Number(val);
      if (!Number.isFinite(n)) return die(`--${m[1]} must be a number`);
      params[name] = n;
    } else params[name] = val;
  }
  if (spec?.stdin && params[spec.stdin] === undefined) {
    const v = (await readStdin())?.replace(/\r?\n$/, '');
    if (v?.trim()) params[spec.stdin] = v;
  }
  print(await request(socket, method, params), text);
}

/** A bare string result is a document (e.g. `skills get`), not data: print it as is. */
function print(v: unknown, _text: boolean) {
  process.stdout.write(`${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}\n`);
}

main().catch((e) => die((e as Error).message));
