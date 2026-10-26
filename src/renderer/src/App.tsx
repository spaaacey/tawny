import { memo, useEffect } from 'react';
import { startBridge } from './bridge';
import { NewWorktreeModal } from './components/NewWorktreeModal';
import { Palette } from './components/Palette';
import { QuickSwitcher } from './components/QuickSwitcher';
import { SendBox } from './components/SendBox';
import { Sidebar } from './components/Sidebar';
import { StatusBar } from './components/StatusBar';
import { Toasts } from './components/Toasts';
import markup from './legacy-markup.html?raw';
import { H } from './lib/legacy';
import { useStore } from './store';

// Order matters: these are classic scripts sharing one global lexical scope.
const SCRIPTS = [
  'monaco/vs/loader.js',
  'legacy/themes.js',
  'fileicons/map.js',
  'legacy/dnd.js',
  'legacy/layout.js',
  'legacy/debug.js',
  'legacy/editor.js',
  'legacy/chat.js',
  'legacy/find.js',
];

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

/** The editor / panes / file tree: still imperative DOM owned by the legacy scripts, so React must never touch it. */
const LegacyMain = memo(function LegacyMain() {
  return <main id="main" dangerouslySetInnerHTML={{ __html: markup }} />;
});

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
      .then(startBridge)
      .catch((e) => console.error(e));
  }, []);

  return (
    <>
      {H.dev && (
        <div id="devBanner" className="drag">
          {H.devPort ? `DEV :${H.devPort}` : 'DEV'}
        </div>
      )}
      <div id="app" className={`${side === 'right' ? 'sidebar-right' : ''} ${hidden ? 'no-sidebar' : ''}`.trim()}>
        <Sidebar />
        <LegacyMain />
      </div>
      <StatusBar />
      <div id="termHold" hidden />
      <div id="ctxMenu" hidden />
      <Toasts />
      {overlay === 'worktree' && <NewWorktreeModal />}
      {overlay === 'quick' && <QuickSwitcher />}
      {overlay === 'send' && <SendBox />}
      {overlay === 'palette' && <Palette />}
    </>
  );
}
