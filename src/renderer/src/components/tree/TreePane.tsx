import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/ui/resizable';
import { ScrollArea } from '@/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { sendToAgent as sendTextToAgent } from '../../lib/actions';
import { useDock } from '../../lib/dnd';
import { iconSrc } from '../../lib/fileicons';
import { H } from '../../lib/tawny';
import { theme } from '../../lib/theme';
import { useStore } from '../../store';
import { ContextMenu } from '../ContextMenu';
import { DebugView } from '../debug/DebugPanel';
import { showPanel, useDbg } from '../debug/session';
import { openDiff, openFile } from '../editor/api';
import { Chevron, GoToFile } from '../icons';
import { activeFile, activeKey } from '../workspace/layoutStore';
import { dragFile } from '../workspace/panes';
import { AsksView, useOpenAsks } from './AsksView';
import { FindView } from './FindView';
import { PrFilesView } from './PrFilesView';
import { ReviewView } from './ReviewView';
import {
  applyGit,
  baseName,
  type Change,
  type Commit,
  cancelCreate,
  cancelRename,
  collapseAll,
  commit,
  commitCreate,
  commitRename,
  type Entry,
  type Git,
  moveTreeSide,
  pasteDir,
  pasteInto,
  pathsOf,
  relTo,
  selKey,
  setDraft,
  setFocused,
  setSelection,
  setSide,
  setView,
  setWidth,
  showView,
  startCreate,
  startRename,
  toggleCommit,
  toggleDir,
  toggleSection,
  toggleTree,
  trashPath,
  undoCommit,
  useTree,
  type View,
} from './store';

const EMPTY_GIT: Git = { isRepo: true, status: {}, staged: [], unstaged: [], log: [], stat: { add: 0, del: 0 } };

const RAIL: { v: View; title: string; svg: React.ReactNode }[] = [
  {
    v: 'files',
    title: 'Files',
    svg: (
      <path
        d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3 M5.5 8h5 M5.5 10.5h5"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    ),
  },
  {
    v: 'pr',
    title: 'PR files',
    svg: (
      <path
        d="M4.5 2.5v11 M4.5 5a1.7 1.7 0 1 0 0-.01 M4.5 11a1.7 1.7 0 1 0 0 .01 M11.5 13.5V6.5c0-1.2-.8-2-2-2H8 M9.5 2.5l-1.8 2 1.8 2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    v: 'changes',
    title: 'Source',
    svg: (
      <>
        <circle cx="4.5" cy="3.5" r="1.7" fill="none" stroke="currentColor" />
        <circle cx="4.5" cy="12.5" r="1.7" fill="none" stroke="currentColor" />
        <circle cx="11.5" cy="5.5" r="1.7" fill="none" stroke="currentColor" />
        <path d="M4.5 5.2v5.6 M11.5 7.2c0 2.3-2.5 2.3-6 3.3" fill="none" stroke="currentColor" />
      </>
    ),
  },
  {
    v: 'find',
    title: 'Find',
    svg: (
      <>
        <circle cx="6.5" cy="6.5" r="4" fill="none" stroke="currentColor" />
        <path d="M9.5 9.5l4.5 4.5" fill="none" stroke="currentColor" strokeLinecap="round" />
      </>
    ),
  },
  {
    v: 'debug',
    title: 'Debug',
    svg: (
      <path
        d="M5.5 5.5a2.5 2.5 0 0 1 5 0v4a2.5 2.5 0 0 1-5 0z M5.5 7.5h-3 M10.5 7.5h3 M5.5 10.5l-2.5 2 M10.5 10.5l2.5 2 M6 3L4.5 1.5 M10 3l1.5-1.5"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    v: 'asks',
    title: 'Asks',
    svg: (
      <path
        d="M2.5 3.5h11v7h-6l-3 3v-3h-2z M5.5 6h5 M5.5 8h3"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
      />
    ),
  },
  {
    v: 'review',
    title: 'Review',
    svg: (
      <path
        d="M2.5 2.5h11v9h-4.5l-2 2.5-2-2.5h-2.5z M5.5 7l1.7 1.7 3.3-3.4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
];

const sendToAgent = (rel: string) => sendTextToAgent(`@${rel} `);
const copy = (t: string) => navigator.clipboard.writeText(t);

// ---------------------------------------------------------------- files

interface Row extends Entry {
  depth: number;
  code: string;
  open: boolean;
}

const NEW_ROW = '\0new';

function CreateRow({ depth, kind, dir }: { depth: number; kind: 'file' | 'dir'; dir: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const busy = useRef(false);
  const done = useRef(false);
  const submit = async () => {
    if (busy.current || done.current) return;
    if (!val.trim()) {
      done.current = true;
      return cancelCreate();
    }
    busy.current = true;
    const e = await commitCreate(val);
    busy.current = false;
    if (e) setErr(e);
    else done.current = true;
  };
  return (
    <div>
      <div className="tn" style={{ paddingLeft: 8 + depth * 12 }}>
        <span className="tw" />
        <img className="ti" src={iconSrc(val || 'x', kind, false)} draggable={false} alt="" />
        <Input
          autoFocus
          className="h-[22px] rounded-sm px-1 py-0 text-[13px] md:text-[13px]"
          value={val}
          aria-invalid={!!err}
          placeholder={kind === 'file' ? 'File name' : 'Folder name'}
          onChange={(e) => {
            setVal(e.target.value);
            setErr(null);
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') {
              done.current = true;
              cancelCreate();
            }
          }}
          onBlur={submit}
          data-dir={dir}
        />
      </div>
      {err && (
        <div className="text-destructive text-[11px] px-2 py-0.5" style={{ paddingLeft: 8 + depth * 12 + 20 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function RenameRow({ path, name }: { path: string; name: string }) {
  const [err, setErr] = useState<string | null>(null);
  const [val, setVal] = useState(name);
  const done = useRef(false);
  const submit = async () => {
    if (done.current) return;
    const e = await commitRename(path, val);
    if (e) setErr(e);
    else done.current = true;
  };
  return (
    <>
      <Input
        autoFocus
        ref={(el) => {
          if (el && !el.dataset.sel) {
            el.dataset.sel = '1';
            const dot = name.lastIndexOf('.');
            el.setSelectionRange(0, dot > 0 ? dot : name.length);
          }
        }}
        className="h-[22px] flex-1 min-w-0 rounded-sm px-1 py-0 text-[13px] md:text-[13px]"
        value={val}
        aria-invalid={!!err}
        title={err ?? undefined}
        onChange={(e) => {
          setVal(e.target.value);
          setErr(null);
        }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') submit();
          else if (e.key === 'Escape') {
            done.current = true;
            cancelRename();
          }
        }}
        onBlur={() => {
          if (done.current) return;
          done.current = true;
          cancelRename();
        }}
      />
      {err && <span className="text-destructive text-[11px] pl-1 truncate">{err}</span>}
    </>
  );
}

const HeadBtn = ({ title, onClick, d }: { title: string; onClick: () => void; d: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button variant="ghost" size="icon-xs" aria-label={title} onClick={onClick}>
        <svg
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={d} />
        </svg>
      </Button>
    </TooltipTrigger>
    <TooltipContent>{title}</TooltipContent>
  </Tooltip>
);

function FilesView() {
  const root = useTree((s) => s.root);
  const dirs = useTree((s) => s.dirs);
  const expanded = useTree((s) => s.expanded);
  const git = useTree((s) => (s.root ? s.git[s.root] : undefined));
  const revealTick = useTree((s) => s.revealTick);
  const creating = useTree((s) => s.creating);
  const focused = useTree((s) => s.focused);
  const renaming = useTree((s) => s.renaming);
  useTree((s) => s.tick);
  const el = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    if (!root) return [];
    const status = git?.status || {};
    const exp = expanded[root];
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      if (creating?.dir === dir)
        out.push({ name: '', path: NEW_ROW, type: creating.kind, depth, code: '', open: false });
      for (const e of dirs[dir] || []) {
        const r = relTo(root, e.path);
        const code = e.type === 'dir' ? (status[`${r}/`] ? '•' : '') : status[r] || '';
        const open = e.type === 'dir' && !!exp?.has(e.path);
        out.push({ ...e, depth, code, open });
        if (open) walk(e.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [root, dirs, expanded, git, creating]);

  useEffect(() => {
    if (!revealTick) return;
    const p = useTree.getState().revealPath;
    for (const n of el.current?.querySelectorAll<HTMLElement>('.tn') || []) {
      if (n.dataset.p === p) n.scrollIntoView({ block: 'nearest' });
    }
  }, [revealTick]);

  const active = activeFile() as string | null;
  const loaded = root ? dirs[root] !== undefined : true;

  const rootRow = root ? { path: root, type: 'dir' as const } : null;
  return (
    <>
      <div className="group/fh flex items-center h-8 pl-3 pr-1 shrink-0 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        <span className="flex-1 truncate">{root ? baseName(root) : ''}</span>
        <span className="flex opacity-0 group-hover/fh:opacity-100 group-focus-within/fh:opacity-100 transition-opacity">
          <HeadBtn
            title="New File"
            onClick={() => startCreate('file')}
            d="M9.5 1.5h-6v13h9v-10z M9.5 1.5v3h3 M8 7v4 M6 9h4"
          />
          <HeadBtn
            title="New Folder"
            onClick={() => startCreate('dir')}
            d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z M8 7v4 M6 9h4"
          />
          <HeadBtn title="Collapse All" onClick={collapseAll} d="M2.5 2.5h11v11h-11z M5 8h6" />
        </span>
      </div>
      <ContextMenu
        disabled={!root}
        items={() => [
          { label: 'New File…', onSelect: () => startCreate('file', rootRow) },
          { label: 'New Folder…', onSelect: () => startCreate('dir', rootRow) },
          { label: 'Paste', onSelect: () => root && pasteInto(root) },
        ]}
      >
        <div
          ref={pane}
          className="flex-1 min-h-0 flex flex-col outline-none"
          tabIndex={-1}
          onKeyDown={(e) => {
            const f = useTree.getState().focused;
            if (!f || (e.target as HTMLElement).closest('input,textarea')) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              startRename(f);
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
              e.preventDefault();
              trashPath(f);
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            pasteInto(pasteDir());
          }}
        >
          <ScrollArea className="flex-1 min-h-0">
            <div id="tree" ref={el}>
              {rows.map((r) => {
                if (r.path === NEW_ROW)
                  return <CreateRow key={NEW_ROW} depth={r.depth} kind={r.type} dir={creating?.dir || ''} />;
                const g = r.code === '?' ? 'u' : r.code === '•' ? 'd' : r.code.toLowerCase();
                return (
                  <ContextMenu
                    key={r.path}
                    items={() => {
                      const rel = relTo(root, r.path);
                      return [
                        { label: 'New File…', onSelect: () => startCreate('file', r) },
                        { label: 'New Folder…', onSelect: () => startCreate('dir', r) },
                        { label: 'Copy', onSelect: () => H.copyFiles([r.path]) },
                        { label: 'Paste', onSelect: () => pasteInto(pasteDir(r)) },
                        { label: 'Rename', onSelect: () => startRename(r.path) },
                        { label: 'Delete', onSelect: () => trashPath(r.path) },
                        { label: 'Copy Path', onSelect: () => copy(r.path) },
                        { label: 'Copy Relative Path', onSelect: () => copy(rel) },
                        { label: 'Send to Agent', onSelect: () => sendToAgent(rel) },
                        { label: 'Reveal in Finder', onSelect: () => H.reveal(r.path) },
                      ];
                    }}
                  >
                    <div
                      className={`tn ${r.type} ${r.path === active ? 'on' : ''} ${r.path === focused ? 'focus' : ''}${r.ignored ? ' ign' : ''} g${g}`}
                      data-p={r.path}
                      style={{ paddingLeft: 8 + r.depth * 12 }}
                      onClick={() => {
                        setFocused(r.path);
                        if (r.type === 'dir') toggleDir(r.path);
                        else openFile(r.path, { preview: true });
                        // keep focus in the tree (editor steals it) so cmd+v pastes here
                        setTimeout(() => pane.current?.focus({ preventScroll: true }), 50);
                      }}
                      onContextMenu={() => setFocused(r.path)}
                      onDoubleClick={() => r.type !== 'dir' && openFile(r.path, { pin: true })}
                      onMouseDown={(e) => e.button === 0 && r.type !== 'dir' && dragFile(e.nativeEvent, r.path, r.name)}
                    >
                      <span className={`tw${r.open ? ' open' : ''}`}>{r.type === 'dir' && <Chevron />}</span>
                      <img className="ti" src={iconSrc(r.name, r.type, r.open)} draggable={false} alt="" />
                      {renaming === r.path ? (
                        <RenameRow path={r.path} name={r.name} />
                      ) : (
                        <span className="tl">{r.name}</span>
                      )}
                      {r.code === '•' ? (
                        <span className="tg dot">•</span>
                      ) : (
                        r.code && <span className="tg">{r.code === '?' ? 'U' : r.code}</span>
                      )}
                    </div>
                  </ContextMenu>
                );
              })}
              {root && loaded && !rows.length && <div className="tree-empty">Empty folder</div>}
            </div>
          </ScrollArea>
        </div>
      </ContextMenu>
    </>
  );
}

// ---------------------------------------------------------------- source

const ACT_D = {
  stage: 'M8 3v10M3 8h10',
  unstage: 'M3 8h10',
  discard: 'M6.5 3 3.5 6l3 3M3.5 6H9a3.5 3.5 0 0 1 0 7H6',
};
const ACT_TITLE = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard Changes', open: 'Open File' };

function ActBtn({ act, all, onClick }: { act: keyof typeof ACT_TITLE; all?: boolean; onClick: () => void }) {
  return (
    <span
      className="cn-act"
      title={`${ACT_TITLE[act]}${all ? ' All' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {act === 'open' ? (
        <GoToFile />
      ) : (
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d={ACT_D[act]} />
        </svg>
      )}
    </span>
  );
}

const ago = (t: number) => {
  const m = Math.max(0, (Date.now() / 1000 - t) / 60);
  if (m < 1) return 'now';
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 43200) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 43200)}mo`;
};

function ChangesView() {
  const splitLayout = useDefaultLayout({ id: 'changes-split' });
  const root = useTree((s) => s.root);
  const git = useTree((s) => (s.root ? s.git[s.root] : undefined)) || EMPTY_GIT;
  const collapsed = useTree((s) => s.collapsedSecs);
  const selected = useTree((s) => s.selected);
  const anchor = useTree((s) => s.anchor);
  const openCommits = useTree((s) => s.openCommits);
  const commitFiles = useTree((s) => s.commitFiles);
  useTree((s) => s.tick);
  const known = useTree((s) => (s.root ? s.git[s.root] !== undefined : false));

  if (!root) return <div id="changes" />;
  const n = git.staged.length + git.unstaged.length;
  if (known && !git.isRepo)
    return (
      <div id="changes">
        <div className="tree-empty">Not a git repository</div>
      </div>
    );
  if (!n && !git.log.length)
    return (
      <div id="changes">
        <div className="tree-empty">No changes</div>
      </div>
    );

  const active = activeKey() as string | null;
  const listOf = (mode: string) => (mode === 's' ? git.staged : git.unstaged);

  const rowsFor = (mode: string, f: Change) => {
    const abs = `${root}/${f.path}`;
    if (!selected.has(selKey(mode, abs))) return [{ abs, orig: f.orig }];
    return listOf(mode)
      .filter((x) => selected.has(selKey(mode, `${root}/${x.path}`)))
      .map((x) => ({ abs: `${root}/${x.path}`, orig: x.orig }));
  };

  const click = (e: React.MouseEvent, mode: string, f: Change) => {
    const abs = `${root}/${f.path}`;
    const k = selKey(mode, abs);
    const stageable = mode === 's' || mode === 'w';
    if (stageable && (e.metaKey || e.ctrlKey || e.shiftKey)) {
      const list = listOf(mode);
      const next = new Set(selected);
      if (e.shiftKey && anchor?.startsWith(`${mode}\0`)) {
        const a = list.findIndex((x) => selKey(mode, `${root}/${x.path}`) === anchor);
        const b = list.indexOf(f);
        if (!e.metaKey && !e.ctrlKey) next.clear();
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) next.add(selKey(mode, `${root}/${list[i].path}`));
        return setSelection(next, anchor);
      }
      for (const x of [...next]) if (!x.startsWith(`${mode}\0`)) next.delete(x);
      if (!next.delete(k)) next.add(k);
      return setSelection(next, k);
    }
    setSelection(new Set(), stageable ? k : null);
    openDiff(mode, abs, { preview: true });
  };

  const row = (f: Change, mode: string) => {
    const abs = `${root}/${f.path}`;
    const name = baseName(f.path);
    const i = f.path.lastIndexOf('/');
    const act = mode === 's' ? 'unstage' : mode === 'w' ? 'stage' : null;
    const many = () => rowsFor(mode, f);
    return (
      <ContextMenu
        key={`${mode}:${f.path}`}
        items={() => {
          const rows = many();
          const multi = rows.length > 1;
          return [
            ...(mode === 'w'
              ? [
                  {
                    label: multi ? `Stage ${rows.length} Files` : 'Stage',
                    onSelect: () => applyGit('stage', pathsOf(rows)),
                  },
                ]
              : mode === 's'
                ? [
                    {
                      label: multi ? `Unstage ${rows.length} Files` : 'Unstage',
                      onSelect: () => applyGit('unstage', pathsOf(rows)),
                    },
                  ]
                : []),
            ...(f.status === 'D' || mode.startsWith('c:')
              ? []
              : [{ label: 'Open File', onSelect: () => openFile(abs) }]),
            { label: 'Copy Relative Path', onSelect: () => copy(f.path) },
            { label: 'Send to Agent', onSelect: () => sendToAgent(f.path) },
            { label: 'Reveal in Finder', onSelect: () => H.reveal(abs) },
          ];
        }}
      >
        <div
          className={`cn s${f.status}${active === `d:${mode}:${abs}` ? ' on' : ''}${selected.has(selKey(mode, abs)) ? ' sel' : ''}`}
          title={f.orig ? `${f.orig} → ${f.path}` : f.path}
          onClick={(e) => click(e, mode, f)}
          onDoubleClick={() => openDiff(mode, abs, { pin: true })}
        >
          <img className="ti" src={iconSrc(name, 'file')} draggable={false} alt="" />
          <span className="cn-name">{name}</span>
          <span className="cn-dir">{i > 0 ? f.path.slice(0, i) : ''}</span>
          {f.status !== 'D' && !mode.startsWith('c:') && <ActBtn act="open" onClick={() => openFile(abs)} />}
          {mode === 'w' && <ActBtn act="discard" onClick={() => applyGit('discard', pathsOf(many()))} />}
          {act && <ActBtn act={act} onClick={() => applyGit(act, pathsOf(many()))} />}
          <span className="tg">{f.status === '?' ? 'U' : f.status}</span>
        </div>
      </ContextMenu>
    );
  };

  const head = (id: string, label: string, count?: number) => (
    <div className="cn-head" onClick={() => toggleSection(id)}>
      <span className={`tw${collapsed.has(id) ? '' : ' open'}`}>
        <Chevron />
      </span>
      {label}
      {id === (git.unstaged.length ? 'unstaged' : 'staged') && git.stat.add + git.stat.del > 0 && (
        <span className="cn-stat" title="Uncommitted changes (added / deleted lines)">
          <span className="sb-add">+{git.stat.add}</span>
          <span className="sb-del">−{git.stat.del}</span>
        </span>
      )}
      {id === 'unstaged' && (
        <ActBtn
          act="discard"
          all
          onClick={() =>
            applyGit('discard', pathsOf(git.unstaged.map((f) => ({ abs: `${root}/${f.path}`, orig: f.orig }))))
          }
        />
      )}
      {(id === 'staged' || id === 'unstaged') && (
        <ActBtn
          act={id === 'staged' ? 'unstage' : 'stage'}
          all
          onClick={() =>
            applyGit(
              id === 'staged' ? 'unstage' : 'stage',
              pathsOf(
                (id === 'staged' ? git.staged : git.unstaged).map((f) => ({ abs: `${root}/${f.path}`, orig: f.orig })),
              ),
            )
          }
        />
      )}
      {count != null && <span className="cn-n">{count}</span>}
    </div>
  );

  const sec = (id: string, label: string, list: Change[], mode: string) =>
    list.length > 0 && (
      <>
        {head(id, label, list.length)}
        {!collapsed.has(id) && list.map((f) => row(f, mode))}
      </>
    );

  const commitRow = (cm: Commit) => {
    const open = openCommits.has(cm.sha);
    const files = commitFiles[cm.sha];
    return (
      <div key={cm.sha} style={{ display: 'contents' }}>
        <ContextMenu items={[{ label: 'Copy Commit SHA', onSelect: () => copy(cm.sha) }]}>
          <div
            className={`cm${open ? ' open' : ''}`}
            title={`${cm.short} ${cm.author}\n${cm.subject}`}
            onClick={() => toggleCommit(cm.sha)}
          >
            <span className={`tw${open ? ' open' : ''}`}>
              <Chevron />
            </span>
            <span className="cm-sub">{cm.subject}</span>
            {cm.refs.map((r) => (
              <span key={r} className="cm-ref">
                {r}
              </span>
            ))}
            <span className="cm-meta">{ago(cm.time)}</span>
          </div>
        </ContextMenu>
        {open && (files ? files.map((f) => row(f, `c:${cm.sha}`)) : <div className="cm-load">…</div>)}
      </div>
    );
  };

  const top = (
    <div className="cn-top">
      {sec('staged', 'Staged Changes', git.staged, 's')}
      {sec('unstaged', 'Changes', git.unstaged, 'w')}
    </div>
  );
  const log = (
    <div className="cn-log">
      {head('commits', 'Commits')}
      {!collapsed.has('commits') && git.log.map(commitRow)}
    </div>
  );

  return (
    <div id="changes">
      {git.log.length > 0 && !collapsed.has('commits') ? (
        <ResizablePanelGroup
          orientation="vertical"
          className="cn-split"
          defaultLayout={splitLayout.defaultLayout}
          onLayoutChanged={splitLayout.onLayoutChanged}
        >
          <ResizablePanel id="top" defaultSize="60%" minSize="15%">
            {top}
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="log" defaultSize="40%" minSize="15%">
            {log}
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <>
          <div className="cn-topwrap">{top}</div>
          {git.log.length > 0 && log}
        </>
      )}
    </div>
  );
}

function CommitBox() {
  const root = useTree((s) => s.root);
  const git = useTree((s) => (s.root ? s.git[s.root] : undefined));
  const draft = useTree((s) => (s.root ? s.drafts[s.root] || '' : ''));
  const ta = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 140)}px`;
  }, [draft, root]);

  if (!root || (git && !git.isRepo)) return null;
  const staged = git?.staged.length || 0;
  const n = staged + (git?.unstaged.length || 0);
  const disabled = !n || !draft.trim();
  const go = () => !disabled && commit();

  return (
    <div id="commitBox">
      <textarea
        id="commitMsg"
        ref={ta}
        rows={1}
        placeholder="Message (cmd+enter to commit)"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(root, e.target.value)}
        // No Undo/Select All menu roles (they'd hijack Monaco's own cmd+z / cmd+a), so the textarea handles them itself.
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
          const k = e.key.toLowerCase();
          if (k === 'enter') go();
          else if (k === 'a') e.currentTarget.select();
          else if (k === 'z') document.execCommand(e.shiftKey ? 'redo' : 'undo');
          else return;
          e.preventDefault();
        }}
      />
      <div id="commitRow">
        <Button id="commitBtn" size="sm" disabled={disabled} onClick={go}>
          {staged || !n ? 'Commit' : 'Commit All'}
        </Button>
        <Button
          id="undoCommitBtn"
          variant="outline"
          size="sm"
          title="Undo last commit (keeps changes staged)"
          disabled={!git?.log.length}
          onClick={() => undoCommit()}
        >
          Undo
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pane

const prSeen = new Set<string>();

export function TreePane() {
  const view = useTree((s) => s.view);
  const visible = useTree((s) => s.visible);
  const width = useTree((s) => s.width);
  const side = useTree((s) => s.side);
  const stat = useTree((s) => (s.root ? s.git[s.root]?.stat : undefined));
  const asks = useOpenAsks().length;
  const dock = useDbg((s) => s.dock);
  const dbgOpen = useDbg((s) => s.open);
  const changes = useTree((s) =>
    s.root ? (s.git[s.root]?.staged.length || 0) + (s.git[s.root]?.unstaged.length || 0) : 0,
  );
  const pane = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const root = useTree((s) => s.root);
  // a PR review worktree gets the "PR files" view (shown once when it becomes the root)
  const prDir = useStore((s) =>
    root && s.app.repos.some((r) => r.worktrees.some((w) => w.path === root && w.pr)) ? root : null,
  );
  // local review needs a feature worktree (not a PR review one)
  const reviewDir = useStore((s) =>
    root && s.app.repos.some((r) => r.worktrees.some((w) => w.path === root && !w.pr)) ? root : null,
  );
  useEffect(() => {
    if (!reviewDir && useTree.getState().view === 'review') setView('files', false);
  }, [reviewDir]);
  useEffect(() => {
    if (prDir && !prSeen.has(prDir)) {
      prSeen.add(prDir);
      setView('pr', false);
    } else if (!prDir && useTree.getState().view === 'pr') setView('files', false);
    else if (prDir && useTree.getState().view === 'changes') setView('pr', false);
  }, [prDir]);

  // the file icons follow the theme
  useEffect(() => {
    return theme.onChange(() => useTree.setState((s) => ({ tick: s.tick + 1 })));
  }, []);

  // drag the header to dock the pane on the other side
  const dockOverlay = useDock(head, 'panes', () => useTree.getState().side, setSide);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const sx = e.clientX;
    const el = pane.current as HTMLDivElement;
    const sw = el.getBoundingClientRect().width;
    const dir = side === 'left' ? 1 : -1;
    let raw = sw;
    const mv = (ev: MouseEvent) => {
      raw = sw + dir * (ev.clientX - sx);
      el.style.width = `${Math.max(150, Math.min(520, raw))}px`;
    };
    const up = () => {
      removeEventListener('mousemove', mv);
      removeEventListener('mouseup', up);
      // dragged well past the minimum: snap to the minimised rail
      if (raw < 100) {
        el.style.width = '';
        toggleTree();
      } else setWidth(el.style.width);
    };
    addEventListener('mousemove', mv);
    addEventListener('mouseup', up);
  };

  return (
    <>
      {dockOverlay}
      <div id="treeSplit" className="vsplit" hidden={!visible} onMouseDown={startResize} />
      <div
        id="secondarySidebar"
        ref={pane}
        className={visible ? '' : 'min'}
        style={width && visible ? { width } : undefined}
      >
        <div className="tree-tabs" id="treeRail" ref={head} onMouseDown={(e) => e.stopPropagation()}>
          {RAIL.filter(
            (r) => (r.v !== 'pr' || prDir) && (r.v !== 'review' || reviewDir) && !(r.v === 'changes' && prDir),
          ).map((r) => {
            const on = r.v === 'debug' && dock === 'bottom' ? dbgOpen : visible && view === r.v;
            return (
              <button
                type="button"
                key={r.v}
                className={on ? 'on' : ''}
                title={r.v === 'changes' && changes > 0 && stat ? `${r.title} (+${stat.add} −${stat.del})` : r.title}
                onClick={() => (r.v === 'debug' ? showPanel(!on) : on ? toggleTree(false) : showView(r.v))}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  {r.svg}
                </svg>
                {r.v === 'changes' && changes > 0 && <span className="badge">{changes > 99 ? '99+' : changes}</span>}
                {r.v === 'asks' && asks > 0 && <span className="badge">{asks}</span>}
              </button>
            );
          })}
        </div>
        <div id="treeCol" hidden={!visible}>
          {view === 'files' && <FilesView />}
          {view === 'changes' && (
            <>
              <CommitBox />
              <ChangesView />
            </>
          )}
          {view === 'pr' && prDir && <PrFilesView dir={prDir} />}
          {view === 'find' && <FindView />}
          {view === 'asks' && <AsksView />}
          {view === 'review' && reviewDir && <ReviewView />}
          {view === 'debug' && dock === 'side' && <DebugView dock="side" />}
        </div>
      </div>
    </>
  );
}

export { moveTreeSide };
