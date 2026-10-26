import { create } from 'zustand';
import { toast } from '../../lib/actions';
import { Editor, H } from '../../lib/legacy';
import { baseName, showView, useTree } from './store';

export interface Match {
  l: number;
  c: number;
  n: number;
  t: string;
  o: number;
}
export interface FileHit {
  /** absolute */
  path: string;
  rel: string;
  matches: Match[];
  collapsed: boolean;
}
export type Flag = 'matchCase' | 'wholeWord' | 'regex';
export interface FindOpts {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  include: string;
  exclude: string;
}

interface FindState extends FindOpts {
  query: string;
  replace: string;
  replacing: boolean;
  details: boolean;
  files: FileHit[];
  status: 'idle' | 'searching' | 'done' | 'replaced';
  truncated: boolean;
  note: string;
  error: string;
  /** the keyboard-focused row: `f${i}` or `m${i}:${j}` */
  cur: string | null;
  /** bumped to focus + select the query input */
  focusTick: number;
}

export const useFind = create<FindState>(() => ({
  matchCase: false,
  wholeWord: false,
  regex: false,
  include: '',
  exclude: '',
  query: '',
  replace: '',
  replacing: false,
  details: false,
  files: [],
  status: 'idle',
  truncated: false,
  note: '',
  error: '',
  cur: null,
  focusTick: 0,
}));

const get = useFind.getState;
const set = useFind.setState;
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;
let searchedRoot: string | null = null;
let stale = false;

const currentRoot = () => Editor().root as string | null;
const opts = (): FindOpts & { query: string } => {
  const s = get();
  return {
    query: s.query,
    matchCase: s.matchCase,
    wholeWord: s.wholeWord,
    regex: s.regex,
    include: s.include,
    exclude: s.exclude,
  };
};

export function schedule(ms = 250) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
}

export async function run() {
  clearTimeout(timer);
  const root = currentRoot();
  const id = ++seq;
  stale = false;
  set({ error: '' });
  if (!root || !get().query) return set({ files: [], status: 'idle', note: '', cur: null });
  set({ status: 'searching' });
  searchedRoot = root;
  try {
    const r = await H.search(root, opts(), id);
    if (id !== seq || r.cancelled) return;
    const files: FileHit[] = r.files.map((f: { path: string; matches: Match[] }) => ({
      ...f,
      rel: f.path,
      path: `${root}/${f.path}`,
      collapsed: false,
    }));
    set({ files, truncated: r.truncated, status: 'done', note: '', cur: null });
  } catch (e) {
    if (id !== seq) return;
    set({ files: [], status: 'idle', cur: null, error: String((e as Error).message).replace(/^\/.*\/[a-z]*: /, '') });
  }
}

/** What a match turns into, for the inline preview of a pending replace. */
export function replacement(text: string): string {
  const s = get();
  if (!s.regex) return s.replace;
  try {
    const re = new RegExp(s.wholeWord ? `\\b(?:${s.query})\\b` : s.query, s.matchCase ? '' : 'i');
    return text.replace(re, s.replace).replace(/\\n/g, '↵').replace(/\\t/g, '⇥');
  } catch {
    return s.replace;
  }
}

export function toggleFlag(name: Flag) {
  set({ [name]: !get()[name] } as Partial<FindState>);
  schedule(0);
}

export function setReplacing(replacing: boolean) {
  set({ replacing });
}

export const setField = (patch: Partial<FindState>) => set(patch);

export function setCur(cur: string | null) {
  set({ cur });
}

export function toggleFile(i: number) {
  set((s) => ({ files: s.files.map((f, k) => (k === i ? { ...f, collapsed: !f.collapsed } : f)) }));
}

export function collapseAll() {
  set((s) => {
    const all = s.files.every((f) => f.collapsed);
    return { files: s.files.map((f) => ({ ...f, collapsed: !all })) };
  });
}

export function clear() {
  seq++;
  set({ query: '', files: [], status: 'idle', error: '', cur: null, focusTick: get().focusTick + 1 });
}

export function dismiss(fi: number, mj?: number) {
  const files = get().files.flatMap((f, i) => {
    if (i !== fi) return [f];
    if (mj === undefined) return [];
    const matches = f.matches.filter((_, k) => k !== mj);
    return matches.length ? [{ ...f, matches }] : [];
  });
  set({ files, cur: null });
}

const rangeOf = (m: Match) => ({
  startLineNumber: m.l,
  startColumn: m.c + 1,
  endLineNumber: m.l,
  endColumn: m.c + 1 + m.n,
});

export function openMatch(f: FileHit, m: Match, pin: boolean) {
  Editor().openFile(f.path, { selection: rangeOf(m), preview: !pin, pin, focus: pin });
}

/** Replace `ms` (all of the file's matches by default) in file `f`; resolves to the number replaced. */
async function replaceIn(f: { path: string; matches?: Match[] }, ms: Match[], o = opts()): Promise<number> {
  const positions = ms.map((m) => [m.l, m.c]);
  const text = Editor().modelText(f.path) as string | null; // an open file is edited in its editor (left unsaved), else on disk
  const repl = get().replace;
  if (text === null) return (await H.replaceInFile(f.path, o, repl, positions)).length;
  const edits = await H.replaceEdits(text, o, repl, positions);
  Editor().applyModelEdits(f.path, edits);
  return edits.length;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function replaceOne(fi: number, mj: number) {
  const f = get().files[fi];
  const m = f.matches[mj];
  const sameLine = f.matches.some((x, k) => k !== mj && x.l === m.l);
  let n: number;
  try {
    n = await replaceIn(f, [m]);
  } catch (e) {
    return toast(`Replace failed: ${errMsg(e)}`);
  }
  if (n !== 1 || sameLine) return run(); // the file moved on under the results, or the line's other matches shifted
  dismiss(fi, mj);
}

export async function replaceFile(fi: number) {
  const f = get().files[fi];
  let n: number;
  try {
    n = await replaceIn(f, f.matches);
  } catch (e) {
    return toast(`Replace failed: ${errMsg(e)}`);
  }
  if (n !== f.matches.length) return run();
  dismiss(fi);
}

export async function replaceAll() {
  const { files, replacing, replace } = get();
  if (!files.length || !replacing) return;
  const n = files.reduce((s, f) => s + f.matches.length, 0);
  const where = files.length === 1 ? 'in 1 file' : `across ${files.length} files`;
  if (!confirm(`Replace ${n} occurrence${n === 1 ? '' : 's'} ${where} with '${replace}'?`)) return;
  let done = 0;
  let hit = 0;
  for (const f of files) {
    try {
      const k = await replaceIn(f, f.matches);
      done += k;
      if (k) hit++;
    } catch (e) {
      toast(`Replace failed in ${baseName(f.path)}: ${errMsg(e)}`);
    }
  }
  set({
    files: [],
    status: 'replaced',
    note: `Replaced ${done} occurrence${done === 1 ? '' : 's'} in ${hit} file${hit === 1 ? '' : 's'}`,
  });
}

/** Show the view: focus the query, seeded with the editor's selection. */
export function open() {
  const sel = Editor().selectedText() as string;
  if (sel) set({ query: sel });
  set({ focusTick: get().focusTick + 1 });
  if (sel || stale) run();
}

export function showFind() {
  showView('find');
  open();
}

// ---- the '#' mode of the command palette shares this view's options, replace text and replace logic
export const harborFind = {
  getOpts: () => {
    const s = get();
    return { ...opts(), replace: s.replace, replacing: s.replacing };
  },
  /** Set any of query, matchCase, wholeWord, regex, include, exclude, replace, replacing; results turn stale, nothing runs. */
  setOpts(p: Partial<FindOpts & { query: string; replace: string; replacing: boolean }>) {
    set({ ...p, ...(p.include || p.exclude ? { details: true } : {}) });
    const s = get();
    if (s.include || s.exclude) set({ details: true });
    stale = true;
  },
  run,
  replacement,
  /** Replace match `m` of workspace-relative file `rel` for `q` → number replaced. */
  replaceMatch: (rel: string, m: Match, q: string) =>
    replaceIn({ path: `${currentRoot()}/${rel}` }, [m], { ...opts(), query: q }),
  /** Search `q` without a result limit, then Replace All → the summary, or null if declined. */
  async replaceAll(q: string) {
    set({ query: q });
    await run();
    await replaceAll();
    return get().status === 'replaced' ? get().note : null;
  },
};

// results belong to the workspace they searched
useTree.subscribe((s, prev) => {
  if (s.root !== prev.root) {
    if (currentRoot() === searchedRoot) return;
    seq++;
    set({ files: [], status: 'idle' });
    stale = true;
    if (s.view === 'find' && get().query) run();
  } else if (s.view !== prev.view && s.view === 'find' && stale && get().query) run();
});
