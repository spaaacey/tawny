// Biome formatting for the editor: run the project's own biome (node_modules/.bin/biome above the file) over the
// buffer via stdin. "Changes only" keeps just the formatting hunks that touch lines the user changed since HEAD.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as G from './git';

const EXT = /\.(jsx?|tsx?|mjs|cjs|mts|cts|json|jsonc|css|graphql|gql|html|vue|svelte|astro)$/i;

export interface FormatEdit {
  /** 1-based first line replaced, and how many lines (0 = pure insertion before `line`). */
  line: number;
  count: number;
  text: string;
}
export interface FormatResult {
  supported: boolean;
  edits: FormatEdit[];
  error?: string;
}

function findBiome(file: string): string | null {
  let dir = path.dirname(file);
  for (;;) {
    const bin = path.join(dir, 'node_modules', '.bin', 'biome');
    if (fs.existsSync(bin)) return bin;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const run = (cmd: string, args: string[], cwd: string, input?: string, okCodes = [0]) =>
  new Promise<string>((resolve, reject) => {
    const p = execFile(cmd, args, { cwd, maxBuffer: 64 << 20 }, (err, out, errOut) => {
      const code = (err as (Error & { code?: number }) | null)?.code;
      if (!err || okCodes.includes(code as number)) resolve(out);
      else reject(new Error((errOut || err.message).trim().split('\n').slice(0, 3).join('\n')));
    });
    if (input !== undefined) p.stdin?.end(input);
  });

/** `git diff --no-index -U0` hunks between two texts: [oldStart, oldCount, newStart, newCount] (1-based). */
async function hunks(a: string, b: string): Promise<[number, number, number, number][]> {
  if (a === b) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tawny-fmt-'));
  try {
    fs.writeFileSync(path.join(dir, 'a'), a);
    fs.writeFileSync(path.join(dir, 'b'), b);
    const out = await run('git', ['diff', '--no-index', '--no-ext-diff', '-U0', 'a', 'b'], dir, undefined, [0, 1]);
    const res: [number, number, number, number][] = [];
    for (const m of out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm))
      res.push([+m[1], m[2] === undefined ? 1 : +m[2], +m[3], m[4] === undefined ? 1 : +m[4]]);
    return res;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Lines (1-based, in `text`) that differ from the file at HEAD; null when there's no HEAD version (format everything). */
async function changedLines(file: string, text: string): Promise<Set<number> | null> {
  const dir = path.dirname(file);
  let head: string;
  try {
    const rel = (await G.git(dir, ['ls-files', '--full-name', '--', file])).trim();
    if (!rel) return null;
    head = await G.git(dir, ['show', `HEAD:${rel}`]);
  } catch {
    return null;
  }
  const set = new Set<number>();
  for (const [, , s, c] of await hunks(head, text)) {
    if (c === 0) set.add(s); // pure deletion: the line after it counts
    for (let i = 0; i < c; i++) set.add(s + i);
  }
  return set;
}

export async function format(file: string, text: string, changesOnly: boolean): Promise<FormatResult> {
  if (!EXT.test(file)) return { supported: false, edits: [] };
  const bin = findBiome(file);
  if (!bin) return { supported: false, edits: [] };
  let out: string;
  try {
    out = await run(bin, ['format', `--stdin-file-path=${file}`], path.dirname(file), text);
  } catch (e) {
    return { supported: true, edits: [], error: (e as Error).message };
  }
  if (out === text) return { supported: true, edits: [] };
  const lines = out.split('\n');
  const keep = changesOnly ? await changedLines(file, text) : null;
  const edits: FormatEdit[] = [];
  for (const [os_, oc, ns, nc] of await hunks(text, out)) {
    if (keep) {
      // a hunk applies when it touches (or sits right beside) a changed line
      const lo = oc === 0 ? os_ + 1 : os_;
      const hi = oc === 0 ? os_ : os_ + oc - 1;
      let hit = false;
      for (let l = lo - 1; l <= hi + 1 && !hit; l++) hit = keep.has(l);
      if (!hit) continue;
    }
    edits.push({
      line: oc === 0 ? os_ + 1 : os_,
      count: oc,
      text: nc === 0 ? '' : `${lines.slice(ns - 1, ns - 1 + nc).join('\n')}\n`,
    });
  }
  return { supported: true, edits };
}
