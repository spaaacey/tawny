'use strict';
// Bundles the Tiptap-based rich markdown editor (scripts/rich/entry.js) into src/renderer/vendor/rich.js, a plain script
// (the renderer has no module loader and its CSP only allows 'self' scripts). The output is committed.
// Usage: npm run build:rich
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
esbuild.build({
  entryPoints: [path.join(__dirname, 'rich', 'entry.js')],
  outfile: path.join(root, 'src', 'renderer', 'vendor', 'rich.js'),
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'chrome140', legalComments: 'none',
  logLevel: 'info',
}).catch(() => process.exit(1));
