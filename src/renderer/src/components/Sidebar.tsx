import { useEffect, useRef, useState } from 'react';
import type { AnyWorkspace, Repo } from '../../../shared/types';
import {
  activate,
  addRepo,
  deleteWorktree,
  focusTerm,
  newScratch,
  openNewWorktree,
  removeRepo,
  removeWorkspace,
  setSidebarSide,
  stopAgent,
  toast,
} from '../lib/actions';
import { useDock } from '../lib/dnd';
import { H, Layout } from '../lib/legacy';
import { sessionsFor, workspaceLabel } from '../lib/selectors';
import { useStore } from '../store';
import { ContextMenu } from './ContextMenu';
import { Indicator, SessionIndicator } from './Indicator';
import { Branch, Chevron, Folder, Plus, Scratch, Trash, X } from './icons';
import { ScrollArea } from './ui/scroll-area';

function WorkspaceRow({ w, k }: { w: AnyWorkspace; k: number }) {
  const app = useStore((s) => s.app);
  const focusedSession = useStore((s) => s.focusedSession);
  const [renaming, setRenaming] = useState(false);
  const all = sessionsFor(app, w);
  const agents = all.filter((s) => s.kind !== 'terminal');
  const working = agents.filter((s) => s.working).length;
  const waiting = agents.filter((s) => s.waiting).length;
  const isActive = w.path === app.active;
  const plain = !!w.plain;

  const meta: React.ReactNode[] = [];
  if (w.main) meta.push(<span key="main">main</span>);
  if (waiting)
    meta.push(
      <span key="w" className="needs">
        {waiting === 1 && agents.length === 1 ? 'needs input' : `${waiting}/${agents.length} need input`}
      </span>,
    );
  else if (agents.length)
    meta.push(
      working ? (
        <span key="w" className="work">
          {working === 1 && agents.length === 1 ? 'working' : `${working}/${agents.length} working`}
        </span>
      ) : (
        <span key="w">
          {agents.length} agent{agents.length > 1 ? 's' : ''}
        </span>
      ),
    );
  if (w.prunable || w.missing)
    meta.push(
      <span key="m" style={{ color: 'var(--danger)' }}>
        missing
      </span>,
    );

  const startRename = () => setRenaming(true);
  const kindTitle = w.scratch ? 'Scratch workspace' : plain ? 'Folder workspace' : 'Git worktree';
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div className={`ws ${isActive ? 'active' : ''}`}>
      <ContextMenu disabled={!plain} items={[{ label: 'Rename', onSelect: startRename }]}>
        <div
          className={`wt ${isActive ? 'active' : ''}`}
          title={w.path}
          onClick={() => activate(w.path)}
          onDoubleClick={(e) => {
            if (plain && !(e.target as HTMLElement).closest('button')) startRename();
          }}
        >
          <div className="ind">
            <Indicator waiting={waiting > 0} working={working > 0} any={agents.length > 0} />
          </div>
          <div className="kind" title={kindTitle}>
            {w.scratch ? <Scratch /> : plain ? <Folder /> : <Branch />}
          </div>
          <div className="lbl">
            {renaming ? (
              <RenameInput
                initial={workspaceLabel(w)}
                onDone={async (value, save) => {
                  setRenaming(false);
                  if (save && value !== workspaceLabel(w)) {
                    try {
                      await H.renameWorkspace(w.path, value);
                    } catch (e) {
                      toast(e instanceof Error ? e.message : String(e));
                    }
                  }
                }}
              />
            ) : (
              <div className="br">{workspaceLabel(w)}</div>
            )}
            {meta.length > 0 && <div className="meta">{meta}</div>}
          </div>
          <div className="right">
            {k <= 9 && <span className="key">⌥⌘{k}</span>}
            {plain ? (
              <button
                type="button"
                className="icon-btn danger del"
                title={w.scratch ? 'Remove scratch workspace' : 'Remove from Tawny (folder untouched)'}
                onClick={stop(() => removeWorkspace(w.path))}
              >
                <Trash />
              </button>
            ) : (
              !w.main && (
                <button
                  type="button"
                  className="icon-btn danger del"
                  title="Delete worktree"
                  onClick={stop(() => deleteWorktree(w.path))}
                >
                  <Trash />
                </button>
              )
            )}
          </div>
        </div>
      </ContextMenu>
      {all.map((s) => (
        <div
          key={s.id}
          className={`st${focusedSession === s.id ? ' on' : ''}`}
          title={s.kind === 'terminal' ? 'Terminal' : 'Agent'}
          onClick={async () => {
            await activate(w.path);
            Layout().revealAgent(s.id);
            focusTerm(s.id);
          }}
        >
          <div className="ind">
            <SessionIndicator s={s} />
          </div>
          <div className="br">
            {Layout().agentLabel(s) as string}
            {s.summary && <span className="sub">{s.summary}</span>}
          </div>
          <button
            type="button"
            className="icon-btn danger del"
            title={s.kind === 'terminal' ? 'Close terminal' : 'Stop agent'}
            onClick={stop(() => stopAgent(s.id))}
          >
            <Trash />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Inline rename of a scratch/folder workspace: Enter saves, Esc cancels, empty resets to the folder name. */
function RenameInput({ initial, onDone }: { initial: string; onDone(value: string, save: boolean): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(ref.current?.value.trim() ?? '', save);
  };
  return (
    <input
      ref={ref}
      className="ws-edit"
      defaultValue={initial}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
      }}
    />
  );
}

function RepoGroup({ repo, start }: { repo: Repo; start: number }) {
  const collapsed = useStore((s) => s.collapsed.has(repo.path));
  const toggle = useStore((s) => s.toggleCollapsed);
  return (
    <div className={`repo ${collapsed ? 'collapsed' : ''}`}>
      <div className="repo-head">
        <span className="toggle" onClick={() => toggle(repo.path)}>
          <Chevron />
        </span>
        <span className="name toggle" title={repo.path} onClick={() => toggle(repo.path)}>
          {repo.name}
        </span>
        <span className="acts">
          <button
            type="button"
            className="icon-btn"
            title="New worktree"
            onClick={(e) => {
              e.stopPropagation();
              openNewWorktree(repo.path);
            }}
          >
            <Plus />
          </button>
          <button
            type="button"
            className="icon-btn danger"
            title="Remove from Tawny (files untouched)"
            onClick={(e) => {
              e.stopPropagation();
              removeRepo(repo.path);
            }}
          >
            <X />
          </button>
        </span>
      </div>
      {repo.error && <div className="repo-err">{repo.error}</div>}
      <div className="wts">
        {repo.worktrees.map((w, i) => (
          <WorkspaceRow key={w.path} w={{ ...w, repoName: repo.name }} k={start + i} />
        ))}
      </div>
    </div>
  );
}

export function Sidebar() {
  const app = useStore((s) => s.app);
  const legacyReady = useStore((s) => s.legacyReady);
  const labelRef = useRef<HTMLDivElement>(null);

  // drag the "Workspaces" label to dock the sidebar on the other side
  const dockOverlay = useDock(labelRef, 'app', () => useStore.getState().sidebarSide, setSidebarSide, legacyReady);

  const empty = !app.repos.length && !app.workspaces.length;
  const rows = legacyReady;
  let n = 0;
  return (
    <aside id="sidebar">
      {dockOverlay}
      <div className="side-head drag" />
      <div className="side-label" ref={labelRef} title="Drag to move the sidebar to the other side">
        Workspaces
        <button type="button" id="addRepo" className="icon-btn" title="New workspace" onClick={() => H.addMenu()}>
          <Plus size={14} />
        </button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div id="repos">
          {!rows ? null : empty ? (
            <div className="center-msg" style={{ position: 'static', padding: '40px 12px' }}>
              <div className="empty-title">No workspaces</div>
              <button type="button" className="primary-btn" onClick={newScratch}>
                New scratch workspace
              </button>
              <button type="button" className="primary-btn" onClick={addRepo}>
                Add repository
              </button>
            </div>
          ) : (
            <>
              {app.workspaces.length > 0 && (
                <div className="repo plain">
                  <div className="wts">
                    {app.workspaces.map((w) => (
                      <WorkspaceRow key={w.path} w={{ ...w, repoName: '' } as AnyWorkspace} k={++n} />
                    ))}
                  </div>
                </div>
              )}
              {app.repos.map((r) => {
                const start = n + 1;
                n += r.worktrees.length;
                return <RepoGroup key={r.path} repo={r} start={start} />;
              })}
            </>
          )}
        </div>
      </ScrollArea>
      <div className="side-foot">
        <button type="button" id="settingsBtn" className="link-btn" onClick={() => H.openSettings()}>
          Settings
        </button>
        <span id="envNote">
          {!app.tmux
            ? app.platform === 'win32'
              ? 'no tmux on Windows'
              : 'tmux not found — agents stop with Tawny'
            : ''}
        </span>
      </div>
    </aside>
  );
}
