// Find in files: line-by-line regex/literal search over a workspace's files (git-aware list, so ignored files are
// skipped), plus the matching replace. Matches never span lines.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as F from './files';

const MAX_SIZE = 2 * 1024 * 1024;
const MAX_MATCHES = 10000;
const MAX_LINE = 20000; // longer lines (minified bundles) are skipped
const BATCH = 32;

export interface SearchOpts {
  query: string;
  regex?: boolean;
  matchCase?: boolean;
  wholeWord?: boolean;
  include?: string;
  exclude?: string;
  limit?: number;
}
export interface Match {
  l: number;
  c: number;
  n: number;
  t: string;
  o: number;
}
export interface Edit {
  l: number;
  c: number;
  n: number;
  text: string;
}

let current = 0; // id of the newest search; older ones stop at their next batch

function buildRegex({ query, regex, matchCase, wholeWord }: SearchOpts) {
  if (!query) throw new Error('Empty query');
  let src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (wholeWord)
    src = regex ? `\\b(?:${src})\\b` : `${/^\w/.test(query) ? '\\b' : ''}${src}${/\w$/.test(query) ? '\\b' : ''}`;
  return new RegExp(src, matchCase ? 'g' : 'gi');
}

/** "a, b/**, {c,d}" → patterns, splitting on commas outside braces. */
function splitGlobs(s?: string) {
  const out: string[] = [];
  let depth = 0,
    cur = '';
  for (const ch of s || '') {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function globToRegex(glob: string) {
  glob = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  const anchored = glob.includes('/');
  glob = glob.replace(/^\/+/, '');
  let re = '',
    brace = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') {
      brace++;
      re += '(?:';
    } else if (ch === '}' && brace) {
      brace--;
      re += ')';
    } else if (ch === ',' && brace) re += '|';
    else re += ch.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  // a pattern with a slash is relative to the root; without one it matches at any depth. Either also matches what's inside a matched folder.
  return new RegExp(`${anchored ? '^' : '(?:^|/)'}${re}(?:/|$)`);
}

const globMatcher = (s?: string) => {
  const res = splitGlobs(s).map(globToRegex);
  return res.length ? (rel: string) => res.some((r) => r.test(rel)) : null;
};

function* lineMatches(line: string, re: RegExp) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (!m[0].length) {
      re.lastIndex++;
      continue;
    }
    yield m;
  }
}

/** Preview of `line` around a match at `c` (length `n`): { t, o } text and the match's offset in it. */
function preview(line: string, c: number) {
  const lead = line.length - line.trimStart().length;
  const s = Math.max(lead, c - 30);
  const cut = s > lead;
  return { t: (cut ? '…' : '') + line.slice(s, s + 240).trimEnd(), o: (cut ? 1 : 0) + c - s };
}

async function readText(file: string) {
  const st = await fsp.stat(file);
  if (!st.isFile() || st.size > MAX_SIZE) return null;
  const buf = await fsp.readFile(file);
  if (buf.subarray(0, 8192).includes(0)) return null;
  return buf.toString('utf8');
}

/** → { files: [{ path (relative), matches: [{ l (1-based line), c (column), n (length), t, o }] }], total, truncated } or { cancelled } */
async function search(
  root: string,
  o: SearchOpts,
  id: number,
): Promise<{ cancelled: true } | { files: { path: string; matches: Match[] }[]; total: number; truncated: boolean }> {
  current = id;
  const re = buildRegex(o);
  const cap = Math.min(MAX_MATCHES, o.limit || MAX_MATCHES);
  const inc = globMatcher(o.include),
    exc = globMatcher(o.exclude);
  const list = (await F.fileIndex(root)).filter((r) => (!inc || inc(r)) && !(exc && exc(r))).sort();
  const files: { path: string; matches: Match[] }[] = [];
  let total = 0,
    truncated = false;
  for (let i = 0; i < list.length && !truncated; i += BATCH) {
    if (current !== id) return { cancelled: true };
    const texts = await Promise.all(
      list.slice(i, i + BATCH).map((r) => readText(path.join(root, r)).catch(() => null)),
    );
    texts.forEach((text, j) => {
      if (text === null || truncated) return;
      const matches: Match[] = [];
      const lines = text.split(/\r?\n/);
      for (let l = 0; l < lines.length && !truncated; l++) {
        const line = lines[l];
        if (line.length > MAX_LINE) continue;
        for (const m of lineMatches(line, re)) {
          matches.push({ l: l + 1, c: m.index, n: m[0].length, ...preview(line, m.index) });
          if (++total >= cap) {
            truncated = true;
            break;
          }
        }
      }
      if (matches.length) files.push({ path: list[i + j], matches });
    });
  }
  return { files, total, truncated };
}

/** `$1`, `$&`, `$$`, `$<name>` (and `\n`, `\t`, `\\` in regex mode) expanded against match `m`. */
function expand(m: RegExpExecArray, repl: string, regex: boolean) {
  return repl.replace(/\$(\$|&|\d{1,2}|<\w+>)|\\(n|t|\\)/g, (all: string, a: string, b: string) => {
    if (b) return regex ? (b === 'n' ? '\n' : b === 't' ? '\t' : '\\') : all;
    if (a === '$') return '$';
    if (a === '&') return m[0];
    if (a[0] === '<') return m.groups?.[a.slice(1, -1)] ?? '';
    return m[+a] ?? '';
  });
}

/**
 * Edits that replace the matches in `text` (all of them, or only those at `positions`, an array of [line, col]):
 * [{ l, c, n, text }] with 1-based line, column and length of the old text, in document order.
 */
function replaceEdits(text: string, o: SearchOpts, repl: string, positions?: [number, number][]): Edit[] {
  const re = buildRegex(o);
  const want = positions && new Set(positions.map(([l, c]: [number, number]) => `${l}:${c}`));
  const edits: Edit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of lineMatches(line, re)) {
      if (!want || want.has(`${i + 1}:${m.index}`))
        edits.push({ l: i + 1, c: m.index, n: m[0].length, text: o.regex ? expand(m, repl, true) : repl });
    }
  });
  return edits;
}

/** Apply replaceEdits to the file on disk → the edits made. */
async function replaceInFile(file: string, o: SearchOpts, repl: string, positions?: [number, number][]) {
  const text = await readText(file);
  if (text === null) return [];
  const edits = replaceEdits(text, o, repl, positions);
  if (!edits.length) return edits;
  const starts = [0];
  for (const m of text.matchAll(/\n/g)) starts.push((m.index ?? 0) + 1);
  let out = text;
  for (const e of [...edits].reverse()) {
    const at = starts[e.l - 1] + e.c;
    out = out.slice(0, at) + e.text + out.slice(at + e.n);
  }
  await F.write(file, out);
  return edits;
}

export { replaceEdits, replaceInFile, search };
