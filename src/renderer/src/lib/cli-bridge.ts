// Renderer side of the `tawny` CLI bridge (src/main/cli/bridge.ts). Main forwards CLI calls that need UI state;
// features register a handler per method (e.g. `tab.list`) and return a JSON-able result, or throw for an error.
import { H } from './tawny';

type Handler = (params: never) => unknown | Promise<unknown>;
const handlers = new Map<string, Handler>();

export function registerCliHandler<P = Record<string, unknown>>(
  method: string,
  fn: (params: P) => unknown | Promise<unknown>,
) {
  handlers.set(method, fn as Handler);
}

registerCliHandler('ping', () => ({ ok: true }));

export function initCliBridge() {
  H.onCliRequest(async ({ id, method, params }) => {
    const fn = handlers.get(method);
    if (!fn) return H.cliReply({ id, error: `renderer has no handler for ${method}` });
    try {
      H.cliReply({ id, result: (await fn(params as never)) ?? null });
    } catch (e) {
      H.cliReply({ id, error: (e as Error).message });
    }
  });
}
