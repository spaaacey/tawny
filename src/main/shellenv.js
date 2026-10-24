'use strict';
// Apps launched from Finder/Dock get a minimal PATH. Pull the user's real login-shell
// environment so `code`, `claude`, `tmux`, `git` etc. resolve like in their terminal.
const { execFileSync } = require('child_process');

function loadShellEnv() {
  if (process.platform === 'win32') return;
  const shell = process.env.SHELL || '/bin/zsh';
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__HARBOR_ENV__"; env; printf "__HARBOR_ENV__"'], {
      encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const body = out.split('__HARBOR_ENV__')[1] || '';
    for (const line of body.split('\n')) {
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const k = line.slice(0, i), v = line.slice(i + 1);
      if (['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK', 'NVM_DIR', 'HOMEBREW_PREFIX'].includes(k) ||
          k.startsWith('ANTHROPIC_') || k.startsWith('OPENAI_') || k.startsWith('CLAUDE_')) {
        process.env[k] = v;
      }
    }
  } catch { /* keep defaults */ }
  // common extra locations, in case the shell rc didn't add them
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`];
  const parts = (process.env.PATH || '').split(':');
  for (const p of extra) if (!parts.includes(p)) parts.push(p);
  process.env.PATH = parts.join(':');
  delete process.env.TMUX;
  if (!process.env.LANG) process.env.LANG = 'en_US.UTF-8';
}

module.exports = { loadShellEnv };
