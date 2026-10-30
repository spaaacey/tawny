import { setEditorCursorStyle } from '../components/editor/host';
import { setTermCursorStyle } from './terminals';

type Style = 'line' | 'block' | 'underline';
let current: Style | null = null;

/** settings.cursorStyle: Monaco, xterm and (via CSS caret-shape) every input / textarea. */
export function syncCursor(raw?: string) {
  const s: Style = raw === 'block' || raw === 'underline' ? raw : 'line';
  if (s === current) return;
  current = s;
  document.documentElement.dataset.cursor = s;
  setEditorCursorStyle(s);
  setTermCursorStyle(s === 'line' ? 'bar' : s);
}
