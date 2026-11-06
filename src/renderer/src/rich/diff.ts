// Rich markdown diff core (pure): compares two parsed ProseMirror JSON docs and returns one merged block list with change
// marks. Added / removed / paired blocks get a `diff` attr ('add' | 'del' | 'old' | 'new' | 'mod'); changed words inside
// paired prose blocks get `diffIns` / `diffDel` marks. Render-invisible source changes (whitespace, `*` vs `_`, list
// markers, reflow, table padding) normalise away in the block key, so they produce no marks.
import { diffArrays } from 'diff';

export interface Json {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Json[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}
export type Kind = 'add' | 'del' | 'old' | 'new' | 'mod';

/** Block types that carry the `diff` attr (the editor adds it as a global attribute). */
export const DIFF_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'blockquote',
  'codeBlock',
  'htmlBlock',
  'table',
  'horizontalRule',
];

const PROSE = new Set(['paragraph', 'heading']);
const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);
const CONTAINERS = new Set([...LISTS, 'listItem', 'taskItem', 'blockquote']);
const RAW = new Set(['codeBlock', 'htmlBlock']);
const NO_PAIR = new Set(['horizontalRule']);
const MIN_RATIO = 0.3;

/** Same block after dropping everything the rendered view can't show: whitespace runs collapse (except in code). */
function norm(n: Json, raw = false): unknown {
  const r = raw || RAW.has(n.type);
  const o: Record<string, unknown> = { t: n.type };
  if (n.attrs) {
    const { diff: _d, ...a } = n.attrs;
    if (Object.keys(a).length) o.a = a;
  }
  if (n.text !== undefined) o.x = r ? n.text : n.text.replace(/\s+/g, ' ');
  if (n.marks?.length) o.m = [...n.marks].sort((a, b) => a.type.localeCompare(b.type));
  if (n.content) o.c = n.content.map((c) => norm(c, r));
  return o;
}
const key = (n: Json) => JSON.stringify(norm(n));
const attrsKey = (n: Json) => {
  const { diff: _d, ...a } = n.attrs || {};
  return JSON.stringify(a);
};

const textOf = (n: Json): string => n.text ?? (n.content || []).map(textOf).join(' ');
const WORD = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

const mark = (n: Json, diff: Kind): Json => ({ ...n, attrs: { ...n.attrs, diff } });

interface Tok {
  key: string;
  node: Json;
  ws: boolean;
}
function tokens(content: Json[] = []): Tok[] {
  const out: Tok[] = [];
  for (const n of content) {
    if (n.type !== 'text') {
      out.push({ key: key(n), node: n, ws: false });
      continue;
    }
    const mk = JSON.stringify([...(n.marks || [])].sort((a, b) => a.type.localeCompare(b.type)));
    for (const piece of (n.text || '').match(WORD) || []) {
      const ws = /^\s+$/.test(piece);
      const t = ws ? ' ' : piece;
      out.push({ key: `${t}\u0000${mk}`, node: { ...n, text: t }, ws });
    }
  }
  return out;
}

/** Concatenate neighbouring text tokens that share their marks again. */
function join(nodes: Json[]): Json[] {
  const out: Json[] = [];
  for (const n of nodes) {
    const l = out[out.length - 1];
    if (l && l.type === 'text' && n.type === 'text' && JSON.stringify(l.marks || []) === JSON.stringify(n.marks || []))
      out[out.length - 1] = { ...l, text: (l.text || '') + (n.text || '') };
    else out.push(n);
  }
  return out;
}

/** Word-level diff of two inline contents: one merged inline content, changed words carry diffIns / diffDel marks. */
function wordDiff(a: Json[] | undefined, b: Json[] | undefined): Json[] {
  const chunks = diffArrays(tokens(a), tokens(b), { comparator: (x: Tok, y: Tok) => x.key === y.key });
  const out: Json[] = [];
  for (const c of chunks) {
    for (const t of c.value) {
      if (!c.added && !c.removed) out.push(t.node);
      // a removed non-text inline node (image, break) can't carry a mark: it shows on the new side only
      else if (t.node.type === 'text')
        out.push({ ...t.node, marks: [...(t.node.marks || []), { type: c.added ? 'diffIns' : 'diffDel' }] });
      else if (c.added) out.push(t.node);
    }
  }
  return join(out);
}

function ratio(a: Json, b: Json): number {
  const wa =
    textOf(a)
      .match(WORD)
      ?.filter((w) => /\S/.test(w)) || [];
  const wb =
    textOf(b)
      .match(WORD)
      ?.filter((w) => /\S/.test(w)) || [];
  if (!wa.length && !wb.length) return 1;
  const same = diffArrays(wa, wb)
    .filter((c) => !c.added && !c.removed)
    .reduce((s, c) => s + c.value.length, 0);
  return (2 * same) / (wa.length + wb.length);
}

function pairable(o: Json, n: Json): boolean {
  if (o.type !== n.type || NO_PAIR.has(o.type)) return false;
  if (PROSE.has(o.type) || o.type === 'listItem' || o.type === 'taskItem' || o.type === 'blockquote')
    return ratio(o, n) >= MIN_RATIO;
  return true; // lists (diffed item by item), code, tables…
}

function merge(o: Json, n: Json): Json[] {
  const attrsDiffer = attrsKey(o) !== attrsKey(n);
  if (PROSE.has(n.type)) {
    // Inline atoms cannot reliably carry diff marks (images and hard breaks).
    // Preserve both versions of their containing block instead of silently losing deletions.
    const atoms = (node: Json) => (node.content || []).filter((c) => c.type !== 'text').map(key);
    if (JSON.stringify(atoms(o)) !== JSON.stringify(atoms(n))) return [mark(o, 'old'), mark(n, 'new')];
    const content = wordDiff(o.content, n.content);
    return [{ ...(attrsDiffer ? mark(n, 'mod') : n), content }];
  }
  if (CONTAINERS.has(n.type)) {
    const { nodes } = diffNodes(o.content || [], n.content || []);
    return [{ ...(attrsDiffer ? mark(n, 'mod') : n), content: nodes }];
  }
  return [mark(o, 'old'), mark(n, 'new')];
}

function pairUp(removed: Json[], added: Json[]): Json[] {
  const out: Json[] = [];
  let j = 0;
  for (const r of removed) {
    let hit = -1;
    for (let k = j; k < added.length; k++)
      if (pairable(r, added[k])) {
        hit = k;
        break;
      }
    if (hit < 0) {
      out.push(mark(r, 'del'));
      continue;
    }
    for (; j < hit; j++) out.push(mark(added[j], 'add'));
    out.push(...merge(r, added[hit]));
    j = hit + 1;
  }
  for (; j < added.length; j++) out.push(mark(added[j], 'add'));
  return out;
}

/** Diff two block lists; `changed` is false when they are equal once render-invisible differences are ignored. */
export function diffNodes(a: Json[], b: Json[]): { nodes: Json[]; changed: boolean } {
  const chunks = diffArrays(a.map(key), b.map(key));
  const out: Json[] = [];
  let changed = false;
  let i = 0;
  let j = 0;
  for (let c = 0; c < chunks.length; c++) {
    const ch = chunks[c];
    const n = ch.count ?? ch.value.length;
    if (!ch.added && !ch.removed) {
      for (let k = 0; k < n; k++) out.push(b[j++]);
      i += n;
      continue;
    }
    changed = true;
    let removed: Json[] = [];
    let added: Json[] = [];
    if (ch.removed) {
      removed = a.slice(i, i + n);
      i += n;
      const nx = chunks[c + 1];
      if (nx?.added) {
        const m = nx.count ?? nx.value.length;
        added = b.slice(j, j + m);
        j += m;
        c++;
      }
    } else {
      added = b.slice(j, j + n);
      j += n;
    }
    out.push(...pairUp(removed, added));
  }
  return { nodes: out, changed };
}
