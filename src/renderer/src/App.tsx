import { memo, useEffect } from 'react';
import { startBridge } from './bridge';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DebugPanel } from './components/debug/DebugPanel';
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
import markup from './legacy-markup.html?raw';
import { H } from './lib/legacy';
import { useStore } from './store';

// Classic scripts the editor needs as globals; the legacy modules are imported after them (and after the markup exists).
const SCRIPTS = ['monaco/vs/loader.js', 'fileicons/map.js'];

/** Appends every script at once with async=false: downloads run in parallel, execution stays in order. */
function loadScripts(srcs: string[]): Promise<void> {
  return Promise.all(
    srcs.map(
      (src) =>
        new Promise<void>((resolve, reject) => {
          const el = document.createElement('script');
          el.src = src;
          el.async = false;
          el.onload = () => resolve();
          el.onerror = () => reject(new Error(`failed to load ${src}`));
          document.body.appendChild(el);
        }),
    ),
  ).then(() => undefined);
}

/** The tab layout / editors: still imperative DOM owned by the legacy scripts, so React must never touch it. */
const LegacyWorkspace = memo(function LegacyWorkspace() {
  return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: markup }} />;
});

function Panes() {
  const legacyReady = useStore((s) => s.legacyReady);
  const left = useTree((s) => s.side) === 'left';
  return (
    <main id="main">
      <div id="panes" className={left ? 'tree-left' : ''}>
        <LegacyWorkspace />
        {legacyReady && <TreePane />}
        {legacyReady && <DebugPanel />}
      </div>
    </main>
  );
}

export function App() {
  const side = useStore((s) => s.sidebarSide);
  const hidden = useStore((s) => s.sidebarHidden);
  const overlay = useStore((s) => s.overlay);

  useEffect(() => {
    // StrictMode and HMR both re-run this effect; the classic scripts must load once per page
    const w = window as Window & { __legacyStarted?: boolean };
    if (w.__legacyStarted) return;
    w.__legacyStarted = true;
    if (navigator.platform.toUpperCase().includes('MAC')) document.body.classList.add('mac');
    if (H.dev) {
      document.body.classList.add('dev');
      document.title = 'Tawny (dev)';
    }
    H.state().then((s) => useStore.getState().setApp(s));
    loadScripts(SCRIPTS.map((s) => `./${s}`))
      .then(() => import('./legacy/layout'))
      .then(() => import('./legacy/editor'))
      .then(startBridge)
      .catch((e) => console.error(e));
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
      <div id="ctxMenu" hidden />
      <Toasts />
      <ConfirmDialog />
      {overlay === 'worktree' && <NewWorktreeModal />}
      {overlay === 'quick' && <QuickSwitcher />}
      {overlay === 'send' && <SendBox />}
      {overlay === 'palette' && <Palette />}
    </TooltipProvider>
  );
}
