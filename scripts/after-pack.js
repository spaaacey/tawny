// electron-builder always strips *.d.ts from the bundle, but the native TypeScript 7 binary
// (@typescript/typescript-<os>-<arch>) needs its lib.*.d.ts next to the executable or `tsc --lsp` panics.
// Copy them back into the unpacked tree.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const scope = path.join(__dirname, '..', 'node_modules', '@typescript');
  if (!fs.existsSync(scope)) return;
  for (const pkg of fs.readdirSync(scope)) {
    const src = path.join(scope, pkg, 'lib');
    const dest = path.join(resources, 'app.asar.unpacked', 'node_modules', '@typescript', pkg, 'lib');
    if (!fs.existsSync(src) || !fs.existsSync(dest)) continue; // other platforms' binaries aren't packaged
    for (const f of fs.readdirSync(src)) if (f.endsWith('.d.ts')) fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
};
