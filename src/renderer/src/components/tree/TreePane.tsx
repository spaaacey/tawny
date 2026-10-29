import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { sendToAgent as sendTextToAgent } from '../../lib/actions';
import { useDock } from '../../lib/dnd';
import { iconSrc } from '../../lib/fileicons';
import { H } from '../../lib/tawny';
import { theme } from '../../lib/theme';
import { useStore } from '../../store';
import { ContextMenu } from '../ContextMenu';
import { openDiff, openFile } from '../editor/api';
import { Chevron } from '../icons';
import { ScrollArea } from '../ui/scroll-area';
import { activeFile, activeKey } from '../workspace/layoutStore';
import { dragFile } from '../workspace/panes';
import { FindView } from './FindView';
import {
  applyGit,
  baseName,
  type Change,
  type Commit,
  commit,
  type Entry,
  type Git,
  moveTreeSide,
  pathsOf,
  relTo,
  selKey,
  setDraft,
  setSelection,
  setSide,
  setWidth,
  showView,
  toggleCommit,
  toggleDir,
  toggleSection,
  toggleTree,
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
];

const sendToAgent = (rel: string) => sendTextToAgent(`@${rel} `);
const copy = (t: string) => navigator.clipboard.writeText(t);

// ---------------------------------------------------------------- files

interface Row extends Entry {
  depth: number;
  code: string;
  open: boolean;
}

function FilesView() {
  const root = useTree((s) => s.root);
  const dirs = useTree((s) => s.dirs);
  const expanded = useTree((s) => s.expanded);
  const git = useTree((s) => (s.root ? s.git[s.root] : undefined));
  const revealTick = useTree((s) => s.revealTick);
  useTree((s) => s.tick);
  const el = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    if (!root) return [];
    const status = git?.status || {};
    const exp = expanded[root];
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
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
  }, [root, dirs, expanded, git]);

  useEffect(() => {
    if (!revealTick) return;
    const p = useTree.getState().revealPath;
    for (const n of el.current?.querySelectorAll<HTMLElement>('.tn') || []) {
      if (n.dataset.p === p) n.scrollIntoView({ block: 'nearest' });
    }
  }, [revealTick]);

  const active = activeFile() as string | null;
  const loaded = root ? dirs[root] !== undefined : true;

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div id="tree" ref={el}>
        {rows.map((r) => {
          const g = r.code === '?' ? 'u' : r.code === '•' ? 'd' : r.code.toLowerCase();
          return (
            <ContextMenu
              key={r.path}
              items={() => {
                const rel = relTo(root, r.path);
                return [
                  { label: 'Copy Path', onSelect: () => copy(r.path) },
                  { label: 'Copy Relative Path', onSelect: () => copy(rel) },
                  { label: 'Send to Agent', onSelect: () => sendToAgent(rel) },
                  { label: 'Reveal in Finder', onSelect: () => H.reveal(r.path) },
                ];
              }}
            >
              <div
                className={`tn ${r.type} ${r.path === active ? 'on' : ''} g${g}`}
                data-p={r.path}
                style={{ paddingLeft: 8 + r.depth * 12 }}
                onClick={() => (r.type === 'dir' ? toggleDir(r.path) : openFile(r.path, { preview: true }))}
                onDoubleClick={() => r.type !== 'dir' && openFile(r.path, { pin: true })}
                onMouseDown={(e) => e.button === 0 && r.type !== 'dir' && dragFile(e.nativeEvent, r.path, r.name)}
              >
                <span className={`tw${r.open ? ' open' : ''}`}>{r.type === 'dir' && <Chevron />}</span>
                <img className="ti" src={iconSrc(r.name, r.type, r.open)} draggable={false} alt="" />
                <span className="tl">{r.name}</span>
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
  );
}

// ---------------------------------------------------------------- source

const ACT_D = {
  stage: 'M8 3v10M3 8h10',
  unstage: 'M3 8h10',
  discard: 'M6.5 3 3.5 6l3 3M3.5 6H9a3.5 3.5 0 0 1 0 7H6',
};
const ACT_TITLE = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard Changes' };

function ActBtn({ act, all, onClick }: { act: keyof typeof ACT_D; all?: boolean; onClick: () => void }) {
  return (
    <span
      className="cn-act"
      title={`${ACT_TITLE[act]}${all ? ' All' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
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

  return (
    <div id="changes">
      <div className="cn-topwrap">
        <div className="cn-top">
          {sec('staged', 'Staged Changes', git.staged, 's')}
          {sec('unstaged', 'Changes', git.unstaged, 'w')}
        </div>
      </div>
      {git.log.length > 0 && (
        <div className="cn-log">
          {head('commits', 'Commits')}
          {!collapsed.has('commits') && git.log.map(commitRow)}
        </div>
      )}
    </div>
  );
}

function CommitBox() {
  const root = useTree((s) => s.root);
  const git = useTree((s) => (s.root ? s.git[s.root] : undefined));
  const draft = useTree((s) => (s.root ? s.drafts[s.root] || '' : ''));
  const settings = useStore((s) => s.app.settings);
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
        style={{ fontFamily: settings.editorFontFamily || undefined, fontSize: `${settings.editorFontSize || 13}px` }}
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
      <button type="button" id="commitBtn" disabled={disabled} onClick={go}>
        {staged || !n ? 'Commit' : 'Commit All'}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- pane

export function TreePane() {
  const view = useTree((s) => s.view);
  const visible = useTree((s) => s.visible);
  const width = useTree((s) => s.width);
  const side = useTree((s) => s.side);
  const stat = useTree((s) => (s.root ? s.git[s.root]?.stat : undefined));
  const changes = useTree((s) =>
    s.root ? (s.git[s.root]?.staged.length || 0) + (s.git[s.root]?.unstaged.length || 0) : 0,
  );
  const pane = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);

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
      el.style.width = `${Math.max(200, Math.min(520, raw))}px`;
    };
    const up = () => {
      removeEventListener('mousemove', mv);
      removeEventListener('mouseup', up);
      // dragged well past the minimum: snap to the minimised rail
      if (raw < 140) {
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
      <div id="treePane" ref={pane} className={visible ? '' : 'min'} style={width && visible ? { width } : undefined}>
        <div className="tree-tabs" id="treeRail" ref={head} onMouseDown={(e) => e.stopPropagation()}>
          {RAIL.map((r) => (
            <button
              type="button"
              key={r.v}
              className={visible && view === r.v ? 'on' : ''}
              title={r.v === 'changes' && changes > 0 && stat ? `${r.title} (+${stat.add} −${stat.del})` : r.title}
              onClick={() => showView(r.v)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                {r.svg}
              </svg>
              {r.v === 'changes' && changes > 0 && <span className="badge">{changes > 99 ? '99+' : changes}</span>}
            </button>
          ))}
        </div>
        <div id="treeCol" hidden={!visible}>
          {view === 'files' && <FilesView />}
          {view === 'changes' && (
            <>
              <CommitBox />
              <ChangesView />
            </>
          )}
          {view === 'find' && <FindView />}
        </div>
      </div>
    </>
  );
}

export { moveTreeSide };
