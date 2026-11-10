// Main-to-renderer request/response channel for CLI methods that need UI state (tabs, focus, open files).
// Main sends `cli:request {id, method, params}` and the renderer answers with ipcRenderer.send('cli:response', ...).
// Renderer handlers are registered with `registerCliHandler` (src/renderer/src/lib/cli-bridge.ts), keyed by method.
import type { IpcMain } from 'electron';

export interface CliRequest {
  id: number;
  method: string;
  params: unknown;
}
export type CliResponse = { id: number; result?: unknown; error?: string };

const DEFAULT_TIMEOUT_MS = 10_000;

export class Bridge {
  private seq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: NodeJS.Timeout }>();

  /** `send` posts to the window and returns false when there is none. */
  constructor(private send: (ch: string, ...a: unknown[]) => boolean) {}

  listen(ipc: IpcMain) {
    ipc.on('cli:response', (_e, r: CliResponse) => {
      const p = this.pending.get(r?.id);
      if (!p) return;
      this.pending.delete(r.id);
      clearTimeout(p.timer);
      if (r.error !== undefined) p.reject(new Error(r.error));
      else p.resolve(r.result ?? null);
    });
  }

  /** Ask the renderer to run `method`. Rejects with `no Tawny window open`, the handler's error, or a timeout. */
  request(method: string, params: unknown = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tawny window did not answer ${method} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const req: CliRequest = { id, method, params };
      if (!this.send('cli:request', req)) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('no Tawny window open'));
      }
    });
  }
}
