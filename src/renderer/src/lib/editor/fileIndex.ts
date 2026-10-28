// ⌘P file search (file mode of the command palette): per-root index of relative paths,
// fuzzy matching with highlight positions and quick-open wiring (rows render in
// components/editor/FileRow.tsx). Editor-layer effects (opening a file, the palette,
// the layout's recent-files list) arrive through `deps`, wired by legacy/editor.ts at
// boot (same pattern as lsp/models.ts's configureModels).
import { currentRoot } from '../../lsp/models';
import { type Pos, sep } from '../../lsp/protocol';
import { H } from '../tawny';

export interface FileMatch {
  f: string;
  hits?: number[];
  score?: number;
  line?: number;
}

/** Editor-layer effects used here; wired by legacy/editor.ts at boot. */
export const deps = {
  openFile: (_path: string, _opts?: { selection?: Pos }): unknown => undefined,
  openPalette: (_initial: string): void => {},
  recentFiles: (_root: string): string[] => [],
};
export function configureFileIndex(d: Partial<typeof deps>) {
  Object.assign(deps, d);
}

const indexByRoot = new Map<string, string[]>(); // root -> [rel]

export const rel = (p: string) =>
  currentRoot() && p.startsWith(currentRoot() + sep) ? p.slice((currentRoot() as string).length + 1) : p;

export const absPath = (f: string) => (f.startsWith('/') ? f : `${currentRoot()}/${f}`);

// file mode of the command palette: empty input = go to file, '>' prefix = commands
export const openQuickOpen = () => currentRoot() && deps.openPalette('');

export const fileIndexLoaded = () => !!currentRoot() && indexByRoot.has(currentRoot() as string);

export async function loadFileIndex() {
  const r = currentRoot();
  if (r && !indexByRoot.has(r)) indexByRoot.set(r, await H.fileIndex(r).catch(() => []));
}

/** Start filling a root's index in the background; failures leave it unloaded so a later load retries. */
export function warmIndex(r: string | null) {
  if (r && !indexByRoot.has(r))
    H.fileIndex(r)
      .then((f: string[]) => indexByRoot.set(r, f))
      .catch(() => {});
}

export const invalidateIndex = (r: string) => indexByRoot.delete(r);

function fuzzy(q: string, s: string) {
  // subsequence match with bonuses for consecutive chars and basename hits
  q = q.toLowerCase();
  const sl = s.toLowerCase();
  const b = sl.lastIndexOf('/') + 1;
  let qi = 0,
    score = 0,
    last = -2;
  const hits: number[] = [];
  for (let i = 0; i < sl.length && qi < q.length; i++) {
    if (sl[i] === q[qi]) {
      score +=
        (i === last + 1 ? 5 : 1) +
        (i >= b ? 3 : 0) +
        (i === b || s[i - 1] === '/' || s[i - 1] === '_' || s[i - 1] === '-' || s[i - 1] === '.' ? 4 : 0);
      hits.push(i);
      last = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  score -= s.length * 0.02;
  if (sl.slice(b).startsWith(q)) score += 15;
  return { score, hits };
}

export function fileMatches(raw: string): (FileMatch & { hits: number[]; line: number })[] {
  const [q, line] = raw.trim().split(':');
  const files = (currentRoot() && indexByRoot.get(currentRoot() as string)) || [];
  let res: (FileMatch & { hits: number[] })[];
  if (!q) {
    const recent = deps.recentFiles(currentRoot() as string).map((p) => rel(p));
    res = [...new Set([...recent, ...files])].slice(0, 60).map((f) => ({ f, hits: [] }));
  } else {
    res = [];
    for (const f of files) {
      const m = fuzzy(q.replace(/\s+/g, ''), f);
      if (m) res.push({ f, ...m });
    }
    res.sort((a, b) => (b.score || 0) - (a.score || 0));
    res = res.slice(0, 60);
  }
  return res.map((r) => ({ ...r, line: Number(line) || 0 }));
}

export function openFileResult(r: FileMatch) {
  const p = absPath(r.f);
  return deps.openFile(p, r.line ? { selection: { lineNumber: r.line, column: 1 } } : {});
}
