// Puts `tawny` in reach of everything Tawny spawns: the shim (generated into <userData>/bin each launch, so it
// points at this install's Electron and client script in dev and packaged builds), the PATH entry, and the env vars.
import * as fs from 'node:fs';
import * as path from 'node:path';

export function setupCliEnv(userData: string, socket: string) {
  // out/main/tawny.js next to main.js; Electron runs it as Node. Outside the asar when packaged.
  const script = path.join(__dirname, 'tawny.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const bin = path.join(userData, 'bin');
  try {
    fs.mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'tawny');
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    fs.writeFileSync(file, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(script)} "$@"\n`, {
      mode: 0o755,
    });
    fs.chmodSync(file, 0o755);
  } catch {
    /* no CLI this session */
  }
  process.env.TAWNY = '1';
  process.env.TAWNY_SOCKET = socket;
  const parts = (process.env.PATH || '').split(path.delimiter).filter((p) => p !== bin);
  process.env.PATH = [bin, ...parts].join(path.delimiter);
}

/** Per-process vars: which chat / pane / worktree a spawned process belongs to (commands default to them). */
export function cliEnv(o: { worktree?: string; chatId?: string; paneId?: string }): Record<string, string> {
  const e: Record<string, string> = {};
  if (o.worktree) e.TAWNY_WORKTREE = o.worktree;
  if (o.chatId) e.TAWNY_CHAT_ID = o.chatId;
  if (o.paneId) e.TAWNY_PANE_ID = o.paneId;
  return e;
}
