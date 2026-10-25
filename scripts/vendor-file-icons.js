'use strict';
// Vendors the Catppuccin file-tree icons (MIT, github.com/catppuccin/vscode-icons) from an installed VS Code
// extension into src/renderer/fileicons: one svg folder per flavor plus a compact name → icon map (map.js, a script because the renderer's CSP blocks fetching local files).
// Usage: node scripts/vendor-file-icons.js [path to catppuccin.catppuccin-vsc-icons-x.y.z]
const fs = require('fs');
const os = require('os');
const path = require('path');

const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
const src = process.argv[2] || path.join(extRoot, fs.readdirSync(extRoot).filter(d => d.startsWith('catppuccin.catppuccin-vsc-icons-')).sort().pop());
const out = path.join(__dirname, '..', 'src', 'renderer', 'fileicons');

const theme = JSON.parse(fs.readFileSync(path.join(src, 'dist', 'mocha', 'theme.json'), 'utf8'));
const name = id => path.basename(theme.iconDefinitions[id].iconPath, '.svg');
const mapAll = o => Object.fromEntries(Object.entries(o).map(([k, id]) => [k, name(id)]));

fs.rmSync(out, { recursive: true, force: true });
for (const flavor of ['mocha', 'latte']) fs.cpSync(path.join(src, 'dist', flavor, 'icons'), path.join(out, flavor), { recursive: true });
fs.copyFileSync(path.join(src, 'LICENSE.txt'), path.join(out, 'LICENSE.txt'));
fs.writeFileSync(path.join(out, 'map.js'), 'window.harborFileIcons = ' + JSON.stringify({
  file: name(theme.file), folder: name(theme.folder), folderOpen: name(theme.folderExpanded),
  ext: mapAll(theme.fileExtensions), files: mapAll(theme.fileNames),
  dirs: mapAll(theme.folderNames), dirsOpen: mapAll(theme.folderNamesExpanded),
}) + ';\n');
console.log(`vendored ${path.basename(src)} → ${path.relative(process.cwd(), out)}`);
