// App-level unix socket of the `tawny` CLI: one per Tawny instance, mode 0600 (file permissions are the auth).
// `<userData>/runtime.json` ({pid, socket, version}) lets a shell outside Tawny find it; both go away on quit.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliCtx, Registry } from './registry';

// macOS caps unix socket paths at ~104 bytes
const MAX_SOCK = 100;

export class CliServer {
  readonly socket: string;
  private server: net.Server | null = null;
  private runtimeFile: string;

  constructor(
    private userData: string,
    private registry: Registry,
    private version: string,
    /** Whether a chat id from a caller's env is a live chat */
    private chatExists: (id: string) => boolean,
  ) {
    let sock = path.join(userData, `tawny-${process.pid}.sock`);
    if (sock.length > MAX_SOCK) sock = path.join(os.tmpdir(), `tawny-${process.pid}.sock`);
    this.socket = sock;
    this.runtimeFile = path.join(userData, 'runtime.json');
  }

  start() {
    try {
      fs.unlinkSync(this.socket);
    } catch {
      /* none */
    }
    this.server = net.createServer((c) => {
      let buf = '';
      c.on('data', (d) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = '';
        this.handle(line).then(
          (result) => c.end(`${JSON.stringify({ result: result ?? null })}\n`),
          (e) => c.end(`${JSON.stringify({ error: (e as Error).message })}\n`),
        );
      });
      c.on('error', () => {});
    });
    this.server.on('error', () => {});
    this.server.listen(this.socket, () => {
      try {
        fs.chmodSync(this.socket, 0o600);
      } catch {
        /* */
      }
    });
    try {
      fs.mkdirSync(this.userData, { recursive: true });
      fs.writeFileSync(
        this.runtimeFile,
        JSON.stringify({ pid: process.pid, socket: this.socket, version: this.version }),
        { mode: 0o600 },
      );
    } catch {
      /* the CLI still works with TAWNY_SOCKET */
    }
  }

  private async handle(line: string) {
    const req = JSON.parse(line) as { method?: string; params?: unknown; ctx?: CliCtx };
    if (typeof req.method !== 'string') throw new Error('missing method');
    const ctx: CliCtx = {
      worktree: typeof req.ctx?.worktree === 'string' ? req.ctx.worktree : undefined,
      chatId: typeof req.ctx?.chatId === 'string' ? req.ctx.chatId : undefined,
    };
    // ctx only chooses a default target; a stale chat id is dropped, not trusted
    if (ctx.chatId && !this.chatExists(ctx.chatId)) ctx.chatId = undefined;
    return this.registry.call(req.method, req.params, ctx);
  }

  dispose() {
    this.server?.close();
    this.server = null;
    for (const f of [this.socket, this.runtimeFile]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* gone */
      }
    }
  }
}
