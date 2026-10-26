import '../../../node_modules/monaco-editor/min/vs/editor/editor.main.css';
import '@xterm/xterm/css/xterm.css';
import './styles/legacy.css';
import './globals';
import { createRoot } from 'react-dom/client';
import { App } from './App';

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
