import { cpSync, createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const root = resolve(__dirname, 'src/renderer');

// Dev server serves inline scripts (react-refresh preamble) and a websocket; the packaged app stays strict.
const csp = (dev: boolean) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${dev ? " 'unsafe-inline'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    `connect-src 'self' data:${dev ? ' ws://localhost:*' : ''}`,
    "font-src 'self' data:",
    "worker-src 'self' blob: data:",
  ].join('; ');

const monacoVs = resolve(__dirname, 'node_modules/monaco-editor/min/vs');
const MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};

/** Monaco's AMD build is loaded at runtime by the legacy editor script: serve it in dev, copy it into the bundle on build. */
function monacoAssets(): Plugin {
  let outDir = '';
  return {
    name: 'monaco-assets',
    configResolved: (c) => {
      outDir = resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/monaco/vs', (req, res, next) => {
        const file = join(monacoVs, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(monacoVs) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (outDir) cpSync(monacoVs, join(outDir, 'monaco', 'vs'), { recursive: true });
    },
  };
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/main.ts') },
      commonjsOptions: { include: [/src\/main/, /node_modules/], transformMixedEsModules: true },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
      commonjsOptions: { include: [/src\/preload/, /node_modules/], transformMixedEsModules: true },
    },
  },
  renderer: {
    root,
    base: './',
    publicDir: resolve(root, 'public'),
    build: { outDir: resolve(__dirname, 'out/renderer'), rollupOptions: { input: resolve(root, 'index.html') } },
    plugins: [
      react(),
      monacoAssets(),
      {
        name: 'csp',
        transformIndexHtml: { order: 'pre', handler: (html, ctx) => html.replace('__CSP__', csp(!!ctx.server)) },
      },
      {
        // legacy scripts are classic <script>s outside the module graph: reload the page when one changes
        name: 'legacy-reload',
        configureServer(server) {
          server.watcher.on('change', (file) => {
            if (file.includes('/public/')) server.ws.send({ type: 'full-reload' });
          });
        },
      },
    ],
  },
});
