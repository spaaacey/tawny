// Isolated dev instance of Harbor: own data dir, no tmux, CDP debug port. Never touches the real app's state.
//   npm run dev [-- --port 9333]   (default: first free port from 9333, so worktrees can run in parallel) [--data /tmp/harbor-dev-x] [--repo <path>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 6);
const data = path.resolve(opt('data', path.join(os.tmpdir(), `harbor-dev-${hash}`)));
let port = opt('port', '');
const repo = path.resolve(opt('repo', root));

const real = path.join(os.homedir(), 'Library', 'Application Support', 'Harbor');
if (data === real) { console.error('refusing to use the real Harbor data dir'); process.exit(1); }

// tmux is shared across Harbor instances (it would adopt/kill the real app's agents), so keep it off
const file = path.join(data, 'harbor.json');
if (!fs.existsSync(file)) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ settings: { useTmux: false, notifyWhenAgentFinishes: false } }, null, 2));
}

/** First port from 9333 up that nothing is listening on. */
async function freePort() {
  for (let p = 9333; p < 9433; p++) {
    const free = await new Promise(res => {
      const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return String(p);
  }
  throw new Error('no free port in 9333-9432');
}

const electron = require('electron');
let child = null;
let restarting = false;
function start() {
  child = spawn(electron, [root, `--remote-debugging-port=${port}`], {
    stdio: 'inherit',
    env: { ...process.env, HARBOR_USER_DATA: data, HARBOR_REPO: repo, HARBOR_DEV: '1', HARBOR_DEV_PORT: port },
  });
  child.on('exit', code => {
    if (restarting) { restarting = false; start(); } else process.exit(code ?? 0);
  });
}
// the rich markdown bundle is generated: build it, then keep rebuilding (the app reloads the window when it changes)
(async () => {
  if (!port) port = await freePort();
  console.log(`harbor dev  data=${data}  cdp=http://localhost:${port}  repo=${repo}`);
  await require('./build-rich').build({ watch: true });
})().then(start, err => { console.error(err.message); process.exit(1); });

// hot reload: main-process edits restart the app here; renderer edits are reloaded by the app itself
let timer;
fs.watch(path.join(root, 'src', 'main'), { recursive: true }, (_ev, file) => {
  if (!file || !file.endsWith('.js')) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(`harbor dev  ${file} changed, restarting`);
    restarting = true;
    if (child) child.kill();
  }, 200);
});
