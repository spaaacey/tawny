// Breadcrumb bar above a group's code editor or diff (diffs: the path only plus symbols when the file is open): the file's path inside the worktree, then the symbols around the cursor
// (LSP document symbols). Clicking a folder / file crumb lists its siblings; clicking a symbol lists its siblings and
// picking one jumps there.
import type * as Monaco from 'monaco-editor';
import { Fragment, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { pushHistory } from '../../lib/editor/history';
import { iconSrc } from '../../lib/fileicons';
import { H } from '../../lib/tawny';
import { currentRoot, metaOf, req } from '../../lsp/models';
import { type DocSym, sep, toDocSymbols } from '../../lsp/protocol';
import { diffs, editors, lspListeners, openFile, toggleInlineDiff } from './host';

declare const monaco: typeof Monaco;

type Item = { label: string; icon?: string; on?: boolean; run: () => void };
type MenuState = { left: number; top: number; items: Item[] };

function CrumbMenu({ menu, close }: { menu: MenuState; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.on')?.scrollIntoView({ block: 'center' });
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    document.addEventListener('mousedown', off, true);
    return () => document.removeEventListener('mousedown', off, true);
  }, [close]);
  return createPortal(
    <div className="crumb-menu" ref={ref} style={{ left: menu.left, top: menu.top }}>
      {menu.items.map((it) => (
        <button
          type="button"
          key={it.label}
          className={it.on ? 'on' : undefined}
          onMouseDown={(e) => e.preventDefault()}
          onClick={it.run}
        >
          {it.icon && <img className="ti" src={it.icon} alt="" draggable={false} />}
          {it.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function Crumbs({ gid, diff = false }: { gid: string; diff?: boolean }) {
  const ed = diff ? diffs.get(gid)?.ed.getModifiedEditor() : editors.get(gid);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const sym = useRef({ syms: [] as DocSym[], model: null as Monaco.editor.ITextModel | null, tok: 0 });
  const [menu, setMenu] = useState<MenuState | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const closeMenu = () => setMenu(null);

  useEffect(() => {
    if (!ed) return;
    const s = sym.current;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      setMenu(null);
      bump();
    };
    const fetchSyms = async () => {
      const model = ed.getModel();
      if (!model) return;
      const my = ++s.tok;
      const r = await req(model, 'textDocument/documentSymbol');
      if (my !== s.tok || ed.getModel() !== model) return;
      s.syms = toDocSymbols(r);
      s.model = model;
      render();
    };
    const refetch = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(fetchSyms, delay);
    };
    const onLsp = () => refetch(300); // LSP finishes starting after the model is shown: retry on status changes
    lspListeners.add(onLsp);
    const subs = [
      ed.onDidChangeModel(() => {
        s.syms = [];
        s.model = null;
        render();
        refetch(0);
      }),
      ed.onDidChangeModelContent(() => refetch(400)),
      ed.onDidChangeCursorPosition(render),
      ed.onDidChangeModelLanguage(() => refetch(0)),
    ];
    render();
    refetch(0); // the model may already be set by the time this mounts
    return () => {
      clearTimeout(timer);
      lspListeners.delete(onLsp);
      for (const d of subs) d.dispose();
    };
  }, [ed]);

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar) bar.scrollLeft = bar.scrollWidth;
  });

  if (!ed) return null;
  const model = ed.getModel();
  const meta = model && metaOf(model);
  const dd = diff ? diffs.get(gid) : undefined;
  const filePath = diff ? (dd?.shown ? dd.path : null) : meta?.path;
  const place = (anchor: HTMLElement, items: Item[]) => {
    const r = anchor.getBoundingClientRect();
    setMenu({ left: r.left, top: r.bottom + 2, items });
  };
  const jump = (s: DocSym) => {
    pushHistory();
    const at = { lineNumber: s.selectionRange.startLineNumber, column: s.selectionRange.startColumn };
    ed.setPosition(at);
    ed.revealPositionInCenterIfOutsideViewport(at);
    ed.focus();
  };
  /** Entries of `dir` (folders first); folders open in place, files open in the editor. `cur` is highlighted. */
  const openDirMenu = async (anchor: HTMLElement, dir: string, cur: string) => {
    let ents: { name: string; path: string; type: string }[] = [];
    try {
      ents = await H.list(dir);
    } catch {
      /* unreadable folder: empty menu */
    }
    ents = [...ents].sort((x, y) => (x.type === y.type ? x.name.localeCompare(y.name) : x.type === 'dir' ? -1 : 1));
    place(
      anchor,
      ents.map((e) => ({
        label: e.name,
        icon: iconSrc(e.name, e.type === 'dir' ? 'dir' : 'file'),
        on: e.path === cur,
        run: () => {
          if (e.type === 'dir') openDirMenu(anchor, e.path, '');
          else {
            closeMenu();
            openFile(e.path, { preview: true });
          }
        },
      })),
    );
  };

  const crumbs: React.ReactNode[] = [];
  if (filePath) {
    const r = (diff && dd?.root) || currentRoot();
    const inRoot = !!r && filePath.startsWith(r + sep);
    const relPath = inRoot ? filePath.slice((r as string).length + 1) : filePath;
    const parts = relPath.split(sep).filter(Boolean);
    let acc = inRoot ? (r as string) : '';
    parts.forEach((p, i) => {
      const parent = acc || sep;
      acc = acc + sep + p;
      const full = acc;
      const isFile = i === parts.length - 1;
      crumbs.push(
        <button
          type="button"
          key={full}
          className={`crumb sym${isFile ? ' file' : ''}`}
          onClick={(e) => openDirMenu(e.currentTarget, parent, full)}
        >
          <img className="ti" src={iconSrc(p, isFile ? 'file' : 'dir')} alt="" draggable={false} />
          {p}
        </button>,
      );
    });
    const pos = ed.getPosition();
    const s = sym.current;
    if (meta && s.model === model && pos) {
      let level = s.syms;
      for (let depth = 0; ; depth++) {
        const found = level.find((x) => monaco.Range.containsPosition(x.range, pos));
        if (!found) break;
        const siblings = level;
        crumbs.push(
          <button
            type="button"
            key={`s${depth}`}
            className="crumb sym"
            onClick={(e) =>
              place(
                e.currentTarget,
                siblings.map((x) => ({
                  label: x.name,
                  on: x === found,
                  run: () => {
                    closeMenu();
                    jump(x);
                  },
                })),
              )
            }
          >
            {found.name}
          </button>,
        );
        level = found.children || [];
      }
    }
  }
  return (
    <div className="crumbs" ref={barRef} hidden={!filePath}>
      {crumbs.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && <i>›</i>}
          {c}
        </Fragment>
      ))}
      {dd && (
        <button
          type="button"
          className={`crumb-inline${dd.inline ? ' on' : ''}`}
          title={dd.inline ? 'Show side by side' : 'Show in a single editor (inline)'}
          onClick={() => {
            toggleInlineDiff(dd);
            bump();
          }}
        >
          {dd.inline ? 'Inline' : 'Side by side'}
        </button>
      )}
      {menu && <CrumbMenu menu={menu} close={closeMenu} />}
    </div>
  );
}
