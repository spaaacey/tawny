// Pane toolbar: the 24px bar between a pane's tab strip and its body, with per-tab-kind content (docs/pane-toolbar-plan.md).
// File-ish tabs (code, rich md, diff, image, binary, mermaid): the file's path inside the worktree as breadcrumbs, then (code /
// diff) the symbols around the cursor (LSP document symbols). Clicking a folder / file crumb lists its siblings; clicking a
// symbol lists its siblings and picking one jumps there. PR / chat / terminal tabs: a short trail + a copy button.

import { CopyIcon, MapPinIcon } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import {
  Fragment,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { agentInfo, toast } from '../../lib/actions';
import { pushHistory } from '../../lib/editor/history';
import { iconSrc } from '../../lib/fileicons';
import { H } from '../../lib/tawny';
import { currentRoot, metaOf, req } from '../../lsp/models';
import { type DocSym, sep, toDocSymbols } from '../../lsp/protocol';
import { useStore } from '../../store';
import type { Leaf } from '../workspace/layoutStore';
import { agentLabel, useGroupView } from '../workspace/panes';
import { diffs, editors, lineRange, lspListeners, openFile, useEditorReady } from './host';
import { useMermaidTabs } from './mermaidTab';

declare const monaco: typeof Monaco;

const CRUMB = 'h-auto gap-0 px-1 py-px text-[12px] font-normal text-muted-foreground';

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
        <Button
          variant="ghost"
          size="xs"
          key={it.label}
          className={`h-auto w-full justify-start gap-0 px-2 py-[3px] text-[12px] font-normal text-muted-foreground${it.on ? ' on text-primary' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={it.run}
        >
          {it.icon && <img className="ti" src={it.icon} alt="" draggable={false} />}
          {it.label}
        </Button>
      ))}
    </div>,
    document.body,
  );
}

/** Copy button of the toolbar. */
function CopyButton({ label, icon, text }: { label: string; icon: ReactNode; text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="size-[22px] [&_svg:not([class*=size-])]:size-3.5"
          aria-label={label}
          onClick={() => {
            navigator.clipboard.writeText(text);
            toast(`Copied ${text}`, 2000);
          }}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Bar shell: crumbs separated by ›, then the action buttons. */
function Bar({
  crumbs,
  barRef,
  hidden,
  children,
}: {
  crumbs: ReactNode[];
  barRef?: RefObject<HTMLDivElement | null>;
  hidden?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="pane-toolbar" hidden={hidden}>
      <div className="pane-toolbar-scroll" ref={barRef}>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <i>›</i>}
            {c}
          </Fragment>
        ))}
      </div>
      {children}
    </div>
  );
}

const Crumb = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center px-1 py-px text-[12px] text-foreground">{children}</span>
);

/** What the toolbar shows for the pane's active tab. */
export function PaneToolbar({ g }: { g: Leaf }) {
  const k = g.active;
  if (k?.startsWith('f:')) return <FileBar gid={g.id} path={k.slice(2)} />;
  if (k?.startsWith('d:')) return <FileBar gid={g.id} diff />;
  if (k?.startsWith('m:')) return <MermaidBar k={k} gid={g.id} />;
  if (k?.startsWith('p:')) return <PrBar k={k} />;
  if (k?.startsWith('a:')) return <AgentBar id={k.slice(2)} />;
  return null; // launcher / empty pane
}

function MermaidBar({ k, gid }: { k: string; gid: string }) {
  const info = useMermaidTabs((s) => s.byKey[k]);
  return info ? <FileBar gid={gid} path={info.path} plain extra={`Diagram ${info.n}`} /> : null;
}

function PrBar({ k }: { k: string }) {
  const pr = useStore(
    (s) =>
      s.app.repos.flatMap((r) => r.worktrees).find((w) => w.pr && `p:${w.pr.owner}/${w.pr.repo}#${w.pr.number}` === k)
        ?.pr,
  );
  if (!pr) return null;
  return (
    <Bar
      crumbs={[<Crumb key="r">{`${pr.owner}/${pr.repo}`}</Crumb>, <Crumb key="n">{`#${pr.number} ${pr.title}`}</Crumb>]}
    >
      <CopyButton label="Copy PR link" icon={<CopyIcon />} text={pr.url} />
    </Bar>
  );
}

function AgentBar({ id }: { id: string }) {
  const info = useStore((s) => s.app.sessions.find((x) => x.id === id) ?? null) ?? agentInfo(id);
  const root = currentRoot();
  if (!info) return null;
  const crumbs: ReactNode[] = [];
  if (root) crumbs.push(<Crumb key="w">{root.split(sep).pop()}</Crumb>);
  crumbs.push(<Crumb key="t">{agentLabel(info)}</Crumb>);
  return (
    <Bar crumbs={crumbs}>
      {info.kind === 'terminal' ? (
        root && <CopyButton label="Copy working directory" icon={<CopyIcon />} text={root} />
      ) : (
        <CopyButton label="Copy session id" icon={<CopyIcon />} text={info.id} />
      )}
    </Bar>
  );
}

/** Path crumbs (+ symbols and the line-number copy for code / diff tabs). `plain`: no editor involved (image, binary, mermaid). */
function FileBar({
  gid,
  diff = false,
  path,
  plain = false,
  extra,
}: {
  gid: string;
  diff?: boolean;
  path?: string;
  plain?: boolean;
  extra?: string;
}) {
  useEditorReady((s) => !!s.ready[diff ? `d:${gid}` : gid]);
  const view = useGroupView((s) => s.views[gid]);
  const noEd = plain || (!diff && (!!view?.image || !!view?.binary));
  const ed = noEd ? undefined : diff ? diffs.get(gid)?.ed.getModifiedEditor() : editors.get(gid);
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

  const model = ed?.getModel();
  const meta = model && metaOf(model);
  const dd = diff ? diffs.get(gid) : undefined;
  const filePath = diff ? (dd?.shown ? dd.path : null) : (path ?? meta?.path);
  const place = (anchor: HTMLElement, items: Item[]) => {
    const r = anchor.getBoundingClientRect();
    setMenu({ left: r.left, top: r.bottom + 2, items });
  };
  const jump = (s: DocSym) => {
    if (!ed) return;
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
  const r = (diff && dd?.root) || currentRoot();
  const inRoot = !!r && !!filePath && filePath.startsWith(r + sep);
  const relPath = filePath ? (inRoot ? filePath.slice((r as string).length + 1) : filePath) : '';
  if (filePath) {
    const parts = relPath.split(sep).filter(Boolean);
    let acc = inRoot ? (r as string) : '';
    parts.forEach((p, i) => {
      const parent = acc || sep;
      acc = acc + sep + p;
      const full = acc;
      const isFile = i === parts.length - 1;
      crumbs.push(
        <Button
          variant="ghost"
          size="xs"
          key={full}
          className={`${CRUMB}${isFile ? ' text-foreground' : ''}`}
          onClick={(e) => openDirMenu(e.currentTarget, parent, full)}
        >
          <img className="ti" src={iconSrc(p, isFile ? 'file' : 'dir')} alt="" draggable={false} />
          {p}
        </Button>,
      );
    });
    const pos = ed?.getPosition();
    const s = sym.current;
    if (ed && meta && s.model === model && pos) {
      let level = s.syms;
      for (let depth = 0; ; depth++) {
        const found = level.find((x) => monaco.Range.containsPosition(x.range, pos));
        if (!found) break;
        const siblings = level;
        crumbs.push(
          <Button
            variant="ghost"
            size="xs"
            key={`s${depth}`}
            className={CRUMB}
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
          </Button>,
        );
        level = found.children || [];
      }
    }
  }
  if (extra) crumbs.push(<Crumb key="x">{extra}</Crumb>);
  return (
    <Bar crumbs={crumbs} barRef={barRef} hidden={!filePath}>
      <CopyButton label="Copy relative path" icon={<CopyIcon />} text={relPath} />
      {ed && (
        <CopyButton
          label="Copy relative path with line number"
          icon={<MapPinIcon />}
          text={`${relPath}:${lineRange(ed)}`}
        />
      )}
      {menu && <CrumbMenu menu={menu} close={closeMenu} />}
    </Bar>
  );
}
