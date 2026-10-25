'use strict';
// Bundles the Tiptap-based rich markdown editor (scripts/rich/entry.js) into vendor/rich.js and the chat markdown renderer
// (scripts/chat/entry.js) into vendor/chat.js, plain scripts
// (the renderer has no module loader and its CSP only allows 'self' scripts). The output is generated and gitignored:
// postinstall, `npm run dev` (which also watches) and `npm run dist` build it.
// Usage: npm run build:rich
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const common = { bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'chrome140', legalComments: 'none', logLevel: 'info' };
// vendor/rich.js: the rich markdown editor; vendor/chat.js: markdown rendering for chat tabs
const bundles = [
  { ...common, entryPoints: [path.join(__dirname, 'rich', 'entry.js')], outfile: path.join(root, 'vendor', 'rich.js') },
  { ...common, entryPoints: [path.join(__dirname, 'chat', 'entry.js')], outfile: path.join(root, 'vendor', 'chat.js') },
];

/** Builds once; with { watch } keeps rebuilding on source changes (resolves after the first build). */
async function build({ watch = false } = {}) {
  if (!watch) return Promise.all(bundles.map(o => esbuild.build(o)));
  const ctxs = await Promise.all(bundles.map(o => esbuild.context(o)));
  await Promise.all(ctxs.map(c => c.rebuild()));
  await Promise.all(ctxs.map(c => c.watch()));
  return ctxs;
}

module.exports = { build };
if (require.main === module) build().catch(() => process.exit(1));
