// Isolated dev instance of Tawny: own data dir, no tmux, CDP debug port. Never touches the real app's state.
//   npm run dev [-- --port 9333]   (default: first free port from 9333, so worktrees can run in parallel) [--data /tmp/tawny-dev-x] [--repo <path>]
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (name: string, def: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 6);
const data = path.resolve(opt('data', path.join(os.tmpdir(), `tawny-dev-${hash}`)));
let port = opt('port', '');
const repo = path.resolve(opt('repo', root));

const reals = ['Tawny', 'Harbor'].map((n) => path.join(os.homedir(), 'Library', 'Application Support', n)); // Harbor = legacy
if (reals.includes(data)) { console.error('refusing to use the real Tawny data dir'); process.exit(1); }

// tmux is shared across Tawny instances (it would adopt/kill the real app's agents), so keep it off
const file = path.join(data, 'tawny.json');
if (!fs.existsSync(file) && !fs.existsSync(path.join(data, 'harbor.json'))) { // legacy name is renamed by the app
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ settings: { useTmux: false, notifyWhenAgentFinishes: false } }, null, 2));
}

/** First port from 9333 up that nothing is listening on. */
async function freePort() {
  for (let p = 9333; p < 9433; p++) {
    const free = await new Promise<boolean>(res => {
      const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return String(p);
  }
  throw new Error('no free port in 9333-9432');
}

// electron-vite owns the rest: Vite HMR for the renderer, rebuild + restart for main/preload edits (and legacy scripts full-reload the page)
(async () => {
  if (!port) port = await freePort();
  console.log(`tawny dev  data=${data}  cdp=http://localhost:${port}  repo=${repo}`);
  const bin = path.join(root, 'node_modules', '.bin', 'electron-vite');
  const child = spawn(bin, ['dev', '--', `--remote-debugging-port=${port}`], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, TAWNY_USER_DATA: data, TAWNY_REPO: repo, TAWNY_DEV: '1', TAWNY_DEV_PORT: port },
  });
  child.on('exit', code => process.exit(code ?? 0));
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig as NodeJS.Signals));
})().catch(err => { console.error((err as Error).message); process.exit(1); });
