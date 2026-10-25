'use strict';
// Bundles the Tiptap-based rich markdown editor (scripts/rich/entry.js) into vendor/rich.js, a plain script
// (the renderer has no module loader and its CSP only allows 'self' scripts). The output is generated and gitignored:
// postinstall, `npm run dev` (which also watches) and `npm run dist` build it.
// Usage: npm run build:rich
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const options = {
  entryPoints: [path.join(__dirname, 'rich', 'entry.js')],
  outfile: path.join(root, 'vendor', 'rich.js'),
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'chrome140', legalComments: 'none',
  logLevel: 'info',
};

/** Builds once; with { watch } keeps rebuilding on source changes (resolves after the first build). */
async function build({ watch = false } = {}) {
  if (!watch) return esbuild.build(options);
  const ctx = await esbuild.context(options);
  await ctx.rebuild();
  await ctx.watch();
  return ctx;
}

module.exports = { build };
if (require.main === module) build().catch(() => process.exit(1));
