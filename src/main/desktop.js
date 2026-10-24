'use strict';
// Locate the desktop VS Code CLI for "Open in VS Code".
const fs = require('fs');
const path = require('path');

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function findCode(override) {
  if (override) return fs.existsSync(override) ? override : which(override);
  const home = process.env.HOME || '';
  const candidates = [
    which('code'),
    '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
    `${home}/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code`,
    which('code-insiders'),
    '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

module.exports = { findCode };
