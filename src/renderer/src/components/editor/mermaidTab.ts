// Mermaid diagram tabs ('m:<markdown path>#<n>'): one ```mermaid block of a markdown file, edited in the file's own
// Monaco model (MermaidPane.tsx hides every other line) next to its live diagram.
// A tracker per open tab follows its block while the file is edited: a model decoration spans the block (fence to
// fence), so text inserted above/below moves it; whole-buffer replacements (rich view edits, reloads from disk) drop
// decorations, so then the block is found again by its text (or index). When the block's index changes the tab is
// re-keyed, so the key always names the block it shows (and restores to it after a restart).
import type * as Monaco from 'monaco-editor';
import { create } from 'zustand';
import { ensureModel } from '../../lsp/models';
import { mermaidKey, parseMermaidKey } from '../../lsp/protocol';
import { everyLeaf, hasKey, openKey, renameKey, useLayoutStore } from '../workspace/layoutStore';
import { whenReady } from './api';

declare const monaco: typeof Monaco;
type Model = Monaco.editor.ITextModel;

/** A closed ```mermaid fence pair: 1-based line numbers of the opening and closing fence lines. */
export interface Block {
  open: number;
  close: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Every closed fenced block whose info string is `mermaid`, in document order (CommonMark fence rules, top level only). */
export function mermaidBlocks(lines: string[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!m) continue;
    const fence = m[1];
    const info = m[2].trim();
    if (fence[0] === '`' && info.includes('`')) continue; // not a fence: inline code
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const c = FENCE.exec(lines[j]);
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length && !c[2].trim()) {
        close = j;
        break;
      }
    }
    if (close < 0) break; // unclosed: the rest of the file is its code
    if (info.split(/\s+/)[0].toLowerCase() === 'mermaid') out.push({ open: i + 1, close: close + 1 });
    i = close;
  }
  return out;
}

export const innerText = (model: Model, b: Block) =>
  b.close - b.open > 1
    ? model.getValueInRange(new monaco.Range(b.open + 1, 1, b.close - 1, model.getLineMaxColumn(b.close - 1)))
    : '';

export interface MermaidInfo {
  path: string;
  n: number;
  /** the block, null when it no longer exists (or the file can't be read) */
  block: Block | null;
  /** still loading the file */
  loading: boolean;
  error?: string;
  /** bumps on every change of the block's text */
  rev: number;
}
export const useMermaidTabs = create<{ byKey: Record<string, MermaidInfo | undefined> }>(() => ({ byKey: {} }));

class Tracker {
  key: string;
  path: string;
  n: number;
  model: Model | null = null;
  block: Block | null = null;
  text = '';
  deco: string[] = [];
  len = 0;
  rev = 0;
  loading = true;
  error?: string;
  subs: Monaco.IDisposable[] = [];
  dead = false;

  constructor(key: string, path: string, n: number) {
    this.key = key;
    this.path = path;
    this.n = n;
    this.publish();
    void this.load();
  }

  async load() {
    try {
      await whenReady();
      const m = await ensureModel(this.path, { lsp: true });
      if (this.dead) return;
      if (!m.model) throw new Error('Not a text file');
      this.model = m.model;
    } catch (e) {
      this.loading = false;
      this.error = (e as Error).message || String(e);
      this.publish();
      return;
    }
    const model = this.model;
    this.loading = false;
    this.len = model.getValueLength();
    this.subs.push(
      model.onDidChangeContent((e) => this.changed(e)),
      model.onWillDispose(() => {
        this.detach();
        this.block = null;
        this.error = 'The file was closed';
        this.publish();
      }),
    );
    this.retarget(this.n);
  }

  /** Point at block n (1-based) as the file stands now. */
  retarget(n: number) {
    if (!this.model) return;
    const blocks = mermaidBlocks(this.model.getLinesContent());
    this.set(blocks[n - 1] ?? null, n);
  }

  changed(e: Monaco.editor.IModelContentChangedEvent) {
    const model = this.model as Model;
    const prevLen = this.len;
    this.len = model.getValueLength();
    const whole = e.changes.length === 1 && e.changes[0].rangeOffset === 0 && e.changes[0].rangeLength === prevLen;
    const blocks = mermaidBlocks(model.getLinesContent());
    let hit: Block | null = null;
    let idx = this.n;
    const r = this.deco[0] ? model.getDecorationRange(this.deco[0]) : null;
    if (this.block && !whole && r) {
      // the decoration grows with edits inside the block and moves with edits around it
      const i = blocks.findIndex((b) => b.open === r.startLineNumber && b.close === r.endLineNumber);
      if (i >= 0) [hit, idx] = [blocks[i], i + 1];
    }
    if (!hit && (whole || !this.block)) {
      // decorations are gone (whole-buffer replace) or the block was lost (undo may bring it back): find it by its text
      const same = blocks.map((b, i) => [b, i] as const).filter(([b]) => innerText(model, b) === this.text);
      same.sort((a, b) => Math.abs(a[1] + 1 - this.n) - Math.abs(b[1] + 1 - this.n));
      if (same.length) [hit, idx] = [same[0][0], same[0][1] + 1];
      else if (whole && this.block && blocks[this.n - 1]) [hit, idx] = [blocks[this.n - 1], this.n];
    }
    this.set(hit, idx);
  }

  set(b: Block | null, n: number) {
    const model = this.model as Model;
    this.deco = model.deltaDecorations(
      this.deco,
      b
        ? [
            {
              range: new monaco.Range(b.open, 1, b.close, model.getLineMaxColumn(b.close)),
              options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
            },
          ]
        : [],
    );
    const text = b ? innerText(model, b) : this.text;
    const moved = !this.block || !b || this.block.open !== b.open || this.block.close !== b.close;
    if (text !== this.text || moved) this.rev++;
    this.block = b;
    if (b) this.text = text;
    const to = mermaidKey(this.path, n);
    if (b && n !== this.n && !hasKey(to)) {
      // re-key the tab; tracker and info move first, so neither the pane nor syncTrackers sees the tab without them
      const from = this.key;
      trackers.delete(from);
      trackers.set(to, this);
      this.key = to;
      this.n = n;
      this.publish();
      renameKey(from, to);
      useMermaidTabs.setState((s) => ({ byKey: { ...s.byKey, [from]: undefined } }));
      return;
    }
    this.publish();
  }

  publish() {
    const info: MermaidInfo = {
      path: this.path,
      n: this.n,
      block: this.block,
      loading: this.loading,
      error: this.error,
      rev: this.rev,
    };
    useMermaidTabs.setState((s) => ({ byKey: { ...s.byKey, [this.key]: info } }));
  }

  detach() {
    for (const d of this.subs.splice(0)) d.dispose();
    if (this.model && !this.model.isDisposed()) this.deco = this.model.deltaDecorations(this.deco, []);
    this.deco = [];
  }

  dispose() {
    this.dead = true;
    this.detach();
    useMermaidTabs.setState((s) => ({ byKey: { ...s.byKey, [this.key]: undefined } }));
  }
}

const trackers = new Map<string, Tracker>();
export const trackerOf = (key: string) => trackers.get(key);

/** Keep one tracker per open mermaid tab (in any worktree / page): created for new or restored tabs, dropped with them. */
function syncTrackers() {
  const open = new Set([...everyLeaf()].flatMap((g) => g.tabs).filter((k) => k.startsWith('m:')));
  for (const [k, t] of trackers)
    if (!open.has(k)) {
      t.dispose();
      trackers.delete(k);
    }
  for (const k of open) {
    if (trackers.has(k)) continue;
    const p = parseMermaidKey(k);
    if (p) trackers.set(k, new Tracker(k, p.path, p.n));
  }
}
useLayoutStore.subscribe((s, prev) => {
  if (s.rev !== prev.rev || s.workspaces !== prev.workspaces) syncTrackers();
});

/** From a rendered mermaid block of `path`'s rich view: open (or focus) the tab of its n-th (1-based) block. */
export async function openMermaid(path: string, n: number) {
  const key = mermaidKey(path, n);
  const t = trackers.get(key);
  if (t && !t.block && !t.loading) t.retarget(n); // the tab lost its block: point it at the one asked for
  const gid = await openKey(key, { pin: true });
  if (gid) focusMermaid(gid);
}

/** group id -> the code editor of the mermaid tab it shows (MermaidPane registers it while mounted). */
export const mermaidEditors = new Map<string, Monaco.editor.IStandaloneCodeEditor>();

/** Focus the code editor of group `gid`'s mermaid tab (it mounts after the tab switch renders: retry briefly). */
export function focusMermaid(gid: string) {
  let tries = 0;
  const go = () => {
    const ed = mermaidEditors.get(gid);
    if (ed?.getContainerDomNode().offsetParent) ed.focus();
    else if (tries++ < 20) setTimeout(go, 50);
  };
  go();
}
