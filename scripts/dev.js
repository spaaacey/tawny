// Isolated dev instance of Harbor: own data dir, no tmux, CDP debug port. Never touches the real app's state.
//   npm run dev [-- --port 9333] [--data /tmp/harbor-dev-x] [--repo <path>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };

const hash = crypto.createHash('sha1').update(root).digest('hex').slice(0, 6);
const data = path.resolve(opt('data', path.join(os.tmpdir(), `harbor-dev-${hash}`)));
const port = opt('port', '9333');
const repo = path.resolve(opt('repo', root));

const real = path.join(os.homedir(), 'Library', 'Application Support', 'Harbor');
if (data === real) { console.error('refusing to use the real Harbor data dir'); process.exit(1); }

// tmux is shared across Harbor instances (it would adopt/kill the real app's agents), so keep it off
const file = path.join(data, 'harbor.json');
if (!fs.existsSync(file)) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ settings: { useTmux: false, notifyWhenAgentFinishes: false } }, null, 2));
}

console.log(`harbor dev  data=${data}  cdp=http://localhost:${port}  repo=${repo}`);
const electron = require('electron');
const child = spawn(electron, [root, `--remote-debugging-port=${port}`], {
  stdio: 'inherit',
  env: { ...process.env, HARBOR_USER_DATA: data, HARBOR_REPO: repo },
});
child.on('exit', code => process.exit(code ?? 0));
