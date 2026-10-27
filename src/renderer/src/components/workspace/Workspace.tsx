// The split-pane workspace as React: page bar, pane tree, splitters, tab bars and the launcher.
// Model lives in legacy/layoutStore.ts; the per-group DOM hosts (Monaco, diff, image, terminals)
// stay imperative in ./panes.ts and are adopted into each group's body by GroupPane.
import { memo, type MouseEvent as RMouseEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Leaf, Node, Split } from '../../legacy/layoutStore';
import {
  activate,
  closeKey,
  closePage,
  cur,
  firstLeaf,
  isDirtyKey,
  isLeaf,
  leaves,
  movePage,
  newPage,
  newTab,
  PAGE_COLORS,
  pageLabel,
  persist,
  setPage,
  setPageColor,
  setPageName,
  toggleZoom,
  useLayoutStore,
} from '../../legacy/layoutStore';
import { DiffPane, EditorPane } from '../editor/EditorPane';
import { Launcher } from './Launcher';
import {
  agentLabel,
  beginDrag,
  beginGroupDrag,
  bumpTick,
  getDragKey,
  launcherVisible,
  markFocused,
  regFor,
  syncShown,
  useUiTick,
} from './panes';

const E = () => window.harborEditor;
const APP = () => window.harborApp;
const MIN_PX = 140;

type MenuItem = { label: string; run?(): void; sub?: MenuItem[]; color?: string };

const XIcon = () => (
  <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);
const PlusIcon = () => (
  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
  </svg>
);
const WaitDot = () => <div className="dot wait" style={{ width: 6, height: 6 }} />;
const Spin = () => <div className="spin" style={{ width: 9, height: 9, borderWidth: '1.6px' }} />;

/** Inline text editor for a tab / page chip: Enter or blur saves, Esc cancels. */
function InlineEdit({ value, onDone }: { value: string; onDone(save: boolean, value: string): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(value);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(save, text.trim());
  };
  return (
    <input
      ref={ref}
      className="tname-edit"
      value={text}
      size={Math.max(6, text.length + 1)}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
}

// ------------------------------------------------------------------ tabs

function Tab({ k, g, renaming, rename }: { k: string; g: Leaf; renaming: boolean; rename(k: string | null): void }) {
  const cls = `${k === g.active ? ' on' : ''}${k === getDragKey() ? ' dragging' : ''}`;
  const prev = k === g.preview && !isDirtyKey(k) ? ' preview' : '';
  let name: string;
  let body: React.ReactNode;
  let className: string;
  let title: string | undefined;
  if (k.startsWith('a:')) {
    const info = APP().agentInfo(k.slice(2));
    name = agentLabel(info);
    className = 'gtab agent';
    const ind = info?.waiting ? (
      <WaitDot />
    ) : info?.working ? (
      <Spin />
    ) : (
      <div className="dot idle" style={{ width: 6, height: 6, boxShadow: 'none' }} />
    );
    body = (
      <>
        {ind}
        {renaming ? (
          <InlineEdit
            value={info?.title || name}
            onDone={(save, v) => {
              rename(null);
              if (save && info && v !== name)
                APP().renameAgent(k.slice(2), v === (info.kind === 'terminal' ? info.proc : info.name) ? '' : v);
            }}
          />
        ) : (
          <span className="tname">{name}</span>
        )}
        <span className="gx" title="Stop agent">
          <XIcon />
        </span>
      </>
    );
  } else if (k.startsWith('n:')) {
    name = 'New tab';
    className = 'gtab';
    body = (
      <>
        <span className="tname">New tab</span>
        <span className="gx" title="Close tab">
          <XIcon />
        </span>
      </>
    );
  } else if (k.startsWith('d:')) {
    const info = E().diffInfo(k);
    name = info.name;
    title = info.title;
    className = `gtab file diff${prev}`;
    body = (
      <>
        <span className="tname">{info.name}</span>
        <span className={`gx ${info.dirty ? 'dirty' : ''}`}>{info.dirty ? '●' : '×'}</span>
      </>
    );
  } else {
    const info = E().tabInfo(k.slice(2));
    name = info.name;
    title = info.title;
    className = `gtab file${prev}${info.errs ? ' has-err' : ''}`;
    body = (
      <>
        <span className="tname">{info.name}</span>
        {info.conflict ? (
          <span className="tconf" title="Changed on disk while you had unsaved edits">
            !
          </span>
        ) : null}
        <span className={`gx ${info.dirty ? 'dirty' : ''}`}>{info.dirty ? '●' : '×'}</span>
      </>
    );
  }
  const onGx = (e: React.MouseEvent) => !!(e.target as HTMLElement).closest('.gx');
  return (
    <div
      className={className + cls}
      data-key={k}
      title={title}
      onClick={(e) => {
        if (onGx(e)) {
          e.stopPropagation();
          closeKey(k);
        } else activate(g, k);
      }}
      onDoubleClick={(e) => {
        if (!onGx(e) && !(e.target as HTMLElement).closest('input') && g.preview === k) {
          g.preview = null;
          bumpTick();
        }
      }}
      onContextMenu={(e) => {
        if (!k.startsWith('a:')) return;
        e.preventDefault();
        E().showContextMenu(e.clientX, e.clientY, [{ label: 'Rename', run: () => rename(k) }]);
      }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('input')) return;
        if (e.button === 1) {
          e.preventDefault();
          closeKey(k);
          return;
        }
        if (e.button !== 0 || onGx(e)) return;
        beginDrag(e.nativeEvent, k, name);
      }}
    >
      {body}
    </div>
  );
}

// ------------------------------------------------------------------ group

function GroupPane({
  g,
  focused,
  zoomed,
  tl,
  flex,
}: {
  g: Leaf;
  focused: boolean;
  zoomed: boolean;
  tl: boolean;
  flex?: string;
}) {
  const reg = regFor(g.id);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  // sync terminals / editor mounts (EditorPane / DiffPane below have adopted their hosts by now: child effects run first)
  useLayoutEffect(() => {
    syncShown(g);
  });
  useEffect(() => {
    tabsRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [g.active]);

  return (
    <div
      className={`group${focused ? ' focused' : ''}${zoomed ? ' zoomed' : ''}${tl ? ' tl' : ''}`}
      data-id={g.id}
      style={flex ? { flex } : undefined}
      ref={(el) => {
        reg.el = el;
      }}
      onMouseDownCapture={() => markFocused(g.id)}
    >
      <div
        className="gbar"
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.gx, input, .gnew')) return;
          if (e.target === e.currentTarget || e.target === tabsRef.current) toggleZoom();
        }}
        onMouseDown={(e: RMouseEvent) => {
          if (e.button === 0 && e.target === e.currentTarget && g.tabs.length) beginGroupDrag(e.nativeEvent, g);
        }}
      >
        <div className="gtabs" ref={tabsRef}>
          {g.tabs.map((k) => (
            <Tab key={k} k={k} g={g} renaming={renaming === k} rename={setRenaming} />
          ))}
        </div>
        <button
          type="button"
          className="icon-btn gnew"
          title="New tab (⌘N)"
          onClick={() => {
            markFocused(g.id);
            newTab();
          }}
        >
          <PlusIcon />
        </button>
      </div>
      <div
        className="gbody"
        ref={(el) => {
          reg.body = el;
        }}
      >
        <EditorPane gid={g.id} reg={reg} />
        <DiffPane gid={g.id} reg={reg} />
        <Launcher g={g} hidden={!launcherVisible(g)} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ tree

function SplitView({
  n,
  flex,
  zoom,
  focus,
  firstId,
}: {
  n: Split;
  flex?: string;
  zoom: string | null;
  focus: string | null;
  firstId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const startDrag = (i: number) => (e: RMouseEvent) => {
    const splitEl = ref.current;
    if (e.button !== 0 || !splitEl) return;
    e.preventDefault();
    const row = n.dir === 'row';
    const total = row ? splitEl.clientWidth : splitEl.clientHeight;
    const kids = [...splitEl.children].filter((x) => !x.classList.contains('gsplit')) as HTMLElement[];
    const a0 = n.sizes[i],
      b0 = n.sizes[i + 1],
      start = row ? e.clientX : e.clientY;
    const min = Math.min(MIN_PX / total, (a0 + b0) / 2);
    setDragging(i);
    const mv = (ev: MouseEvent) => {
      const a = Math.max(min, Math.min(a0 + b0 - min, a0 + ((row ? ev.clientX : ev.clientY) - start) / total));
      n.sizes[i] = a;
      n.sizes[i + 1] = a0 + b0 - a;
      kids[i].style.flex = `${n.sizes[i]} 1 0%`;
      kids[i + 1].style.flex = `${n.sizes[i + 1]} 1 0%`;
    };
    const up = () => {
      removeEventListener('mousemove', mv, true);
      removeEventListener('mouseup', up, true);
      setDragging(null);
      persist();
      requestAnimationFrame(() => APP().fitAll());
    };
    addEventListener('mousemove', mv, true);
    addEventListener('mouseup', up, true);
  };
  return (
    <div className={`split ${n.dir}`} ref={ref} style={flex ? { flex } : undefined}>
      {n.children.flatMap((c, i) => {
        const view = (
          <NodeView
            key={isLeaf(c) ? c.id : `s${i}`}
            n={c}
            flex={`${n.sizes[i]} 1 0%`}
            zoom={zoom}
            focus={focus}
            firstId={firstId}
          />
        );
        return i
          ? [
              <div
                key={`h${i}`}
                className={`gsplit ${n.dir}${dragging === i - 1 ? ' drag-on' : ''}`}
                onMouseDown={startDrag(i - 1)}
              />,
              view,
            ]
          : [view];
      })}
    </div>
  );
}

function NodeView({
  n,
  flex,
  zoom,
  focus,
  firstId,
}: {
  n: Node;
  flex?: string;
  zoom: string | null;
  focus: string | null;
  firstId: string;
}) {
  if (isLeaf(n))
    return <GroupPane g={n} focused={focus === n.id} zoomed={zoom === n.id} tl={firstId === n.id} flex={flex} />;
  return <SplitView n={n} flex={flex} zoom={zoom} focus={focus} firstId={firstId} />;
}

function LayoutRoot() {
  useLayoutStore((s) => s.rev);
  useUiTick((s) => s.tick);
  const root = useLayoutStore((s) => s.root);
  const lay = root ? cur() : null;
  return (
    <div id="layoutRoot" className={`${lay && !isLeaf(lay.tree) ? 'multi' : ''}${lay?.zoom ? ' zoomed' : ''}`.trim()}>
      {lay && (
        <NodeView
          key={lay.id}
          n={lay.tree}
          flex="1 1 0%"
          zoom={lay.zoom}
          focus={lay.focus}
          firstId={firstLeaf(lay).id}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ page bar

/** Strip of page chips under the panes; a chip shows a spinner / dot while an agent in that page works / waits. */
function PageBar() {
  useLayoutStore((s) => s.rev);
  useUiTick((s) => s.tick);
  const renamingAt = useUiTick((s) => s.renamePageAt);
  const { root, workspaces } = useLayoutStore.getState();
  const ws = root ? workspaces.get(root) : undefined;
  const [from, setFrom] = useState<number | null>(null);
  const [mark, setMark] = useState<{ i: number; cls: 'drop-before' | 'drop-after' } | null>(null);

  const slot = (e: React.DragEvent) => {
    const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const i = Number(c.dataset.i);
    return { i, to: e.clientX < r.left + r.width / 2 ? i : i + 1 };
  };
  const stopRename = () => useUiTick.setState({ renamePageAt: null });

  return (
    <div
      id="pageBar"
      hidden={!ws}
      onMouseDown={(e) => {
        const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
        if (e.button === 1 && c) {
          e.preventDefault();
          closePage(Number(c.dataset.i));
        }
      }}
      onDragOver={(e) => {
        if (from == null) return;
        e.preventDefault();
        const sl = slot(e);
        setMark(
          sl && sl.to !== from && sl.to !== from + 1
            ? { i: sl.i, cls: sl.to === sl.i ? 'drop-before' : 'drop-after' }
            : null,
        );
      }}
      onDrop={(e) => {
        e.preventDefault();
        const sl = slot(e);
        const f = from;
        setMark(null);
        if (f != null && sl) movePage(f, sl.to);
      }}
      onDragEnd={() => {
        setFrom(null);
        setMark(null);
      }}
      onContextMenu={(e) => {
        const c = (e.target as HTMLElement).closest<HTMLElement>('.pchip');
        e.preventDefault();
        const i = c ? Number(c.dataset.i) : null;
        const items: MenuItem[] = [{ label: 'New Page', run: newPage }];
        if (i != null)
          items.unshift(
            { label: 'Rename', run: () => useUiTick.setState({ renamePageAt: i }) },
            {
              label: 'Color',
              sub: [
                ...PAGE_COLORS.map((c) => ({ label: c.name, color: c.hex, run: () => setPageColor(i, c.hex) })),
                { label: 'None', run: () => setPageColor(i, '') },
              ],
            },
            { label: 'Close Page', run: () => closePage(i) },
          );
        E().showContextMenu(e.clientX, e.clientY, items);
      }}
    >
      {ws?.pages.map((p, i) => {
        const infos = [...leaves(p.tree)]
          .flatMap((g) => g.tabs)
          .filter((k) => k.startsWith('a:'))
          .map((k) => APP().agentInfo(k.slice(2)));
        const ind = infos.some((x) => x?.waiting) ? <WaitDot /> : infos.some((x) => x?.working) ? <Spin /> : null;
        const editing = renamingAt === i;
        return (
          <div
            key={p.id}
            className={`pchip${i === ws.at ? ' on' : ''}${p.color ? ' pc' : ''}${from === i ? ' dragging' : ''}${mark?.i === i ? ` ${mark.cls}` : ''}`}
            data-i={i}
            draggable={!editing}
            style={p.color ? ({ '--pc': p.color } as React.CSSProperties) : undefined}
            onDragStart={(e) => {
              setFrom(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('input')) return;
              if ((e.target as HTMLElement).closest('.gx')) closePage(i);
              else setPage(i);
            }}
            onDoubleClick={(e) => {
              if (!(e.target as HTMLElement).closest('.gx, input')) useUiTick.setState({ renamePageAt: i });
            }}
          >
            {ind}
            {editing ? (
              <InlineEdit
                value={p.name || pageLabel(p, i)}
                onDone={(save, v) => {
                  stopRename();
                  const name = v.slice(0, 60);
                  if (save) setPageName(i, name === `Page ${i + 1}` ? '' : name);
                }}
              />
            ) : (
              <span className="tname">{pageLabel(p, i)}</span>
            )}
            {ws.pages.length > 1 && (
              <span className="gx" title="Close page (tabs move to a neighbour)">
                <XIcon />
              </span>
            )}
          </div>
        );
      })}
      <button type="button" className="icon-btn pnew" title="New page (⌥⇧⌘N)" onClick={() => newPage()}>
        <PlusIcon />
      </button>
    </div>
  );
}

/** Mount points the editor / debug modules still look up by id (`#edStatus`, `#dbgHost`) live here too. */
export const Workspace = memo(function Workspace() {
  return (
    <section id="workspace">
      <LayoutRoot />
      <div id="dbgHost" style={{ display: 'contents' }} />
      <div id="edStatus" hidden />
      <PageBar />
    </section>
  );
});
