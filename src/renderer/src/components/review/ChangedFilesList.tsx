// Changed-files list of a review (PR merge-base diff or a commit; later local branch changes): a folder tree with
// compacted single-child chains, file icons, a git status tag, a per-file viewed checkbox (stored by identity string)
// and an optional per-file count badge (PR: review threads).
import { type ReactNode, useMemo, useState } from 'react';
import { Badge } from '@/ui/badge';
import { Checkbox } from '@/ui/checkbox';
import { iconSrc } from '../../lib/fileicons';
import { Chevron } from '../icons';
import { baseName } from '../tree/store';
import type { ViewedStore } from './viewed';

/** Secondary text: --text mixed toward --bg (>=4.5:1 on both themes; raw --faint/--muted fail on latte). */
export const DIM = 'text-[color-mix(in_srgb,var(--text)_85%,var(--bg))]';

/** One changed file: git name-status letter, and the old path of a rename. */
export interface ChangedFile {
  path: string;
  status: string;
  orig?: string;
}

type DirNode = { name: string; path: string; dirs: DirNode[]; files: ChangedFile[]; all: ChangedFile[] };

/** Build a folder tree; single-child folder chains (no files) are compacted into one row, like GitHub. */
function buildTree(list: ChangedFile[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [], all: [] };
  for (const f of list) {
    let node = root;
    node.all.push(f);
    const parts = f.path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let next = node.dirs.find((d) => d.path === path);
      if (!next) {
        next = { name: parts[i], path, dirs: [], files: [], all: [] };
        node.dirs.push(next);
      }
      next.all.push(f);
      node = next;
    }
    node.files.push(f);
  }
  const sort = (n: DirNode) => {
    n.dirs.sort((a, b) => a.name.localeCompare(b.name));
    n.files.sort((a, b) => baseName(a.path).localeCompare(baseName(b.path)));
    n.dirs.forEach(sort);
  };
  sort(root);
  const compact = (n: DirNode) => {
    n.dirs = n.dirs.map((d) => {
      let cur = d;
      while (cur.files.length === 0 && cur.dirs.length === 1) {
        const only = cur.dirs[0];
        cur = { ...only, name: `${cur.name}/${only.name}` };
      }
      compact(cur);
      return cur;
    });
  };
  compact(root);
  return root;
}

export interface ChangedFilesListProps {
  files: ChangedFile[];
  /** identity the viewed marks are stored under (e.g. a worktree path, `<path>:<sha>`) */
  viewedId: string;
  viewedStore: ViewedStore;
  /** section header text (before the "N/M viewed" counter) */
  title: ReactNode;
  /** shown when `files` is empty */
  emptyText: string;
  /** click (preview) / double click (`pin`) on a file row */
  onOpen: (f: ChangedFile, pin: boolean) => void;
  /** row is the active tab's file (highlighted) */
  isActive?: (f: ChangedFile) => boolean;
  /** badge count per file (collapsed folders show their sum); 0 hides it */
  count?: (path: string) => number;
  /** badge tooltip for `n` */
  countTitle?: (n: number) => string;
}

export function ChangedFilesList({
  files,
  viewedId,
  viewedStore,
  title,
  emptyText,
  onOpen,
  isActive,
  count = () => 0,
  countTitle = (n) => String(n),
}: ChangedFilesListProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const viewed = viewedStore.use(viewedId);
  const seen = new Set(viewed);
  const tree = useMemo(() => buildTree(files), [files]);
  const toggleDir = (p: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (!n.delete(p)) n.add(p);
      return n;
    });
  const renderFile = (f: ChangedFile, depth: number) => {
    const name = baseName(f.path);
    const n = count(f.path);
    return (
      <div
        key={f.path}
        className={`cn s${f.status}${isActive?.(f) ? ' on' : ''}`}
        style={{ paddingLeft: 8 + depth * 12 + 14 }}
        title={f.orig ? `${f.orig} → ${f.path}` : f.path}
        onClick={() => onOpen(f, false)}
        onDoubleClick={() => onOpen(f, true)}
      >
        <Checkbox
          className="border-foreground"
          checked={seen.has(f.path)}
          onClick={(e) => e.stopPropagation()}
          onCheckedChange={(c) => viewedStore.set(viewedId, f.path, c === true)}
          aria-label={`Mark ${f.path} as viewed`}
        />
        <img className="ti" src={iconSrc(name, 'file')} draggable={false} alt="" />
        <span className="cn-name">{name}</span>
        <span className="flex-1" />
        {n > 0 && (
          <Badge variant="outline" title={countTitle(n)}>
            {n}
          </Badge>
        )}
        <span className="tg" onDoubleClick={(e) => e.stopPropagation()}>
          {f.status}
        </span>
      </div>
    );
  };
  const renderDir = (d: DirNode, depth: number): ReactNode => {
    const open = !collapsed.has(d.path);
    const done = d.all.filter((f) => seen.has(f.path)).length;
    const sum = open ? 0 : d.all.reduce((a, f) => a + count(f.path), 0);
    return (
      <div key={d.path}>
        {/* biome-ignore lint/a11y/useSemanticElements: same row element and styles as the file rows */}
        <div
          className="cn"
          role="button"
          tabIndex={0}
          aria-expanded={open}
          style={{ paddingLeft: 8 + depth * 12 }}
          title={d.path}
          onClick={() => toggleDir(d.path)}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault();
              toggleDir(d.path);
            }
          }}
        >
          <span className={`tw${open ? ' open' : ''}`}>
            <Chevron />
          </span>
          <img className="ti" src={iconSrc(baseName(d.path), 'dir', open)} draggable={false} alt="" />
          <span className="cn-name text-foreground">{d.name}</span>
          <span className="flex-1" />
          {sum > 0 && (
            <Badge variant="outline" title={countTitle(sum)}>
              {sum}
            </Badge>
          )}
          {!open && (
            <span className={`shrink-0 font-mono text-[10.5px] ${DIM}`}>
              {done}/{d.all.length}
            </span>
          )}
        </div>
        {open && renderNode(d, depth + 1)}
      </div>
    );
  };
  const renderNode = (n: DirNode, depth: number): ReactNode => (
    <>
      {n.dirs.map((d) => renderDir(d, depth))}
      {n.files.map((f) => renderFile(f, depth))}
    </>
  );
  return (
    <div id="changes">
      <div className="cn-head">
        {title}
        <span className="cn-stat" title="Files marked viewed">
          {files.filter((f) => seen.has(f.path)).length}/{files.length} viewed
        </span>
      </div>
      {renderNode(tree, 0)}
      {!files.length && <div className="tree-empty">{emptyText}</div>}
    </div>
  );
}
