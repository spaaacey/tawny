// Pure editor-side protocol helpers: LSP wire <-> Monaco conversions, language detection, diff-tab keys.
// No Tawny state — safe to import from anywhere in the renderer.
import type * as Monaco from 'monaco-editor';

// Monaco is loaded at runtime by the AMD loader (vs/loader.js) and lands on the global scope.
declare const monaco: typeof Monaco;

// biome-ignore lint/suspicious/noExplicitAny: LSP payloads are loosely typed
type Any = any;

export type Pos = { lineNumber: number; column: number };
export interface LspPos {
  line: number;
  character: number;
}
export interface LspRange {
  start: LspPos;
  end: LspPos;
}
export interface Diag {
  severity?: number;
  message: string;
  source?: string;
  code?: string | number;
  range: LspRange;
  tags?: number[];
}

export const sep = '/';
export const base = (p: string) => p.split(sep).pop() as string;
export const dirname = (p: string) => p.slice(0, p.lastIndexOf(sep)) || sep;

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  rb: 'ruby',
  rake: 'ruby',
  gemspec: 'ruby',
  ru: 'ruby',
  jbuilder: 'ruby',
  erb: 'html',
  json: 'json',
  jsonc: 'json',
  md: 'markdown',
  mdx: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  php: 'php',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  graphql: 'graphql',
  gql: 'graphql',
  dockerfile: 'dockerfile',
  ini: 'ini',
  toml: 'ini',
  env: 'ini',
};
const RUBY_NAMES = new Set(['Gemfile', 'Rakefile', 'Guardfile', 'Capfile', 'Brewfile', 'Podfile', 'Fastfile']);
export function languageFor(p: string) {
  const b = base(p);
  if (RUBY_NAMES.has(b)) return 'ruby';
  if (b === 'Dockerfile') return 'dockerfile';
  if (b.startsWith('.env')) return 'ini';
  const ext = b.includes('.') ? (b.split('.').pop() as string).toLowerCase() : '';
  return LANG_BY_EXT[ext] || 'plaintext';
}

export function uriToPath(u: string) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'file:') return null;
    return decodeURIComponent(url.pathname).replace(/\/{2,}/g, '/');
  } catch {
    return null;
  }
}
export const toLspPos = (p: Pos) => ({ line: p.lineNumber - 1, character: p.column - 1 });
export const toRange = (r: LspRange) =>
  new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
export const toLspRange = (r: Monaco.IRange) => ({
  start: { line: r.startLineNumber - 1, character: r.startColumn - 1 },
  end: { line: r.endLineNumber - 1, character: r.endColumn - 1 },
});

export function markdown(c: Any): Monaco.IMarkdownString[] {
  if (!c) return [];
  if (Array.isArray(c)) return c.flatMap(markdown);
  if (typeof c === 'string') return c ? [{ value: c }] : [];
  if (c.kind === 'plaintext') return [{ value: `\`\`\`text\n${c.value}\n\`\`\`` }];
  if (c.kind === 'markdown') return [{ value: c.value, isTrusted: false, supportHtml: false }];
  if (c.language !== undefined) return [{ value: `\`\`\`${c.language}\n${c.value}\n\`\`\`` }];
  return [];
}
export const docString = (d: Any) =>
  !d ? undefined : typeof d === 'string' ? d : d.kind === 'markdown' ? { value: d.value } : d.value;

export type DocSym = Monaco.languages.DocumentSymbol;
export function toDocSymbols(r: Any[] | null): DocSym[] {
  const conv = (s: Any): DocSym => {
    const range = toRange(s.range || s.location.range);
    return {
      name: s.name,
      detail: s.detail || '',
      kind: Math.max(0, (s.kind || 1) - 1),
      tags: [],
      range,
      selectionRange: s.selectionRange ? toRange(s.selectionRange) : range,
      children: (s.children || []).map(conv),
    };
  };
  return (r || []).map(conv);
}

/** Group an LSP workspace edit (changes | documentChanges) into edits by file path. */
export function editsByFile(edit: Any) {
  const out = new Map<string, Any[]>();
  const add = (uri: string, edits: Any[]) => {
    const p = uriToPath(uri);
    if (!p) return;
    if (!out.has(p)) out.set(p, []);
    out.get(p)?.push(...edits);
  };
  if (edit.changes) for (const [uri, edits] of Object.entries<Any[]>(edit.changes)) add(uri, edits);
  if (edit.documentChanges)
    for (const dc of edit.documentChanges) if (dc.textDocument && dc.edits) add(dc.textDocument.uri, dc.edits);
  return out;
}

// ------------------------------------------------------------------ diff tab keys
// 'd:s:<path>' = staged (HEAD ↔ index, read-only), 'd:w:<path>' = unstaged (index ↔ working tree, editable),
// 'd:c:<sha>:<path>' = a commit (parent ↔ commit, read-only), 'd:t:<n>:<path>' = texts held in memory (an agent's edit, read-only).

export interface ParsedDiff {
  mode: string;
  path: string;
  sha?: string;
  n?: string;
}

export function parseDiff(key: string | null | undefined): ParsedDiff | null {
  const m = /^d:([swcto]):(.*)$/.exec(key || '');
  if (!m) return null;
  if (m[1] === 't' || m[1] === 'o') {
    const t = /^(\d+):(.*)$/.exec(m[2]);
    return t ? { mode: m[1], n: t[1], path: t[2] } : null;
  }
  if (m[1] !== 'c') return { mode: m[1], path: m[2] };
  const c = /^([0-9a-f]{7,40}):(.*)$/.exec(m[2]);
  return c ? { mode: 'c', sha: c[1], path: c[2] } : null;
}
