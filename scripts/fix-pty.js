// node-pty's prebuilt macOS helper is published without the executable bit,
// which makes every terminal fail with "posix_spawnp failed". Restore it.
const fs = require('fs');
const path = require('path');
try {
  const base = path.dirname(require.resolve('node-pty/package.json'));
  for (const dir of ['prebuilds', 'build/Release']) {
    const root = path.join(base, dir);
    if (!fs.existsSync(root)) continue;
    for (const sub of [root, ...fs.readdirSync(root).map(n => path.join(root, n))]) {
      const helper = path.join(sub, 'spawn-helper');
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    }
  }
} catch (e) { console.warn('fix-pty:', e.message); }
