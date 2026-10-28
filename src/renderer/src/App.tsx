import { useEffect } from 'react';
import { boot } from './bridge';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DebugPanel } from './components/debug/DebugPanel';
import { ContextMenu } from './components/editor/ContextMenu';
import { NewWorktreeModal } from './components/NewWorktreeModal';
import { Palette } from './components/Palette';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SendBox } from './components/SendBox';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Toasts } from './components/Toasts';
import { useTree } from './components/tree/store';
import { TreePane } from './components/tree/TreePane';
import { TooltipProvider } from './components/ui/tooltip';
import { Workspace } from './components/workspace/Workspace';
import { H } from './lib/harbor';
import { useStore } from './store';

function Panes() {
  const booted = useStore((s) => s.booted);
  const left = useTree((s) => s.side) === 'left';
  return (
    <main id="main">
      <div id="panes" className={left ? 'tree-left' : ''}>
        <Workspace />
        {booted && <TreePane />}
        {booted && <DebugPanel />}
      </div>
    </main>
  );
}

export function App() {
  const side = useStore((s) => s.sidebarSide);
  const hidden = useStore((s) => s.sidebarHidden);
  const overlay = useStore((s) => s.overlay);

  useEffect(() => {
    // StrictMode re-runs this effect; boot() is idempotent
    if (navigator.platform.toUpperCase().includes('MAC')) document.body.classList.add('mac');
    if (H.dev) {
      document.body.classList.add('dev');
      document.title = 'Tawny (dev)';
    }
    H.state().then((s) => useStore.getState().setApp(s));
    boot();
  }, []);

  return (
    <TooltipProvider delayDuration={400}>
      {H.dev && (
        <div id="devBanner" className="drag">
          {H.devPort ? `DEV :${H.devPort}` : 'DEV'}
        </div>
      )}
      <div id="app" className={`${side === 'right' ? 'sidebar-right' : ''} ${hidden ? 'no-sidebar' : ''}`.trim()}>
        <Sidebar />
        <Panes />
      </div>
      <StatusBar />
      <div id="termHold" hidden />
      <ContextMenu />
      <Toasts />
      <ConfirmDialog />
      {overlay === 'worktree' && <NewWorktreeModal />}
      {overlay === 'quick' && <QuickSwitcher />}
      {overlay === 'send' && <SendBox />}
      {overlay === 'palette' && <Palette />}
    </TooltipProvider>
  );
}
