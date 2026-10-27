import './lib/theme'; // applies the cached theme before first paint
import '../../../node_modules/monaco-editor/min/vs/editor/editor.main.css';
import '@xterm/xterm/css/xterm.css';
import './styles/tailwind.css';
import './globals';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = createRoot(document.getElementById('root') as HTMLElement);
// dev-only component gallery at #gallery (skips the app)
if (import.meta.env.DEV && location.hash === '#gallery') {
  import('./Gallery').then(({ Gallery }) => root.render(<Gallery />));
} else {
  root.render(<App />);
}
