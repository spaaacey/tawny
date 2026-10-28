// Downloads Microsoft's standalone js-debug DAP server (the adapter behind VS Code's Node debugging) into vendor/js-debug.
// Generated and gitignored: postinstall and `npm run dev` fetch it once; failures are non-fatal (the debugger just reports it's missing).
// Usage: npm run fetch:js-debug
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = process.env.TAWNY_JS_DEBUG_VERSION || 'v1.140.0';
export const dest = path.resolve(import.meta.dirname, '..', 'vendor', 'js-debug');
const marker = path.join(dest, '.version');

export async function fetchJsDebug() {
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === VERSION) return;
  const url = `https://github.com/microsoft/vscode-js-debug/releases/download/${VERSION}/js-debug-dap-${VERSION}.tar.gz`;
  console.log(`fetching js-debug ${VERSION}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tawny-jsdebug-'));
  try {
    const tgz = path.join(tmp, 'js-debug.tar.gz');
    fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xzf', tgz, '-C', dest, '--strip-components=1']);   // tarball root is js-debug/
    fs.writeFileSync(marker, VERSION);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (import.meta.main) fetchJsDebug().catch((e: Error) => { console.warn(`js-debug not installed (${e.message}); Node debugging is unavailable`); });
