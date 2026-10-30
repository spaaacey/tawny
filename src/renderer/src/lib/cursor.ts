import { setEditorCursorStyle } from '../components/editor/host';

type Style = 'line' | 'block' | 'underline';
let current: Style | null = null;

/** settings.cursorStyle: Monaco editor only. */
export function syncCursor(raw?: string) {
  const s: Style = raw === 'block' || raw === 'underline' ? raw : 'line';
  if (s === current) return;
  current = s;
  setEditorCursorStyle(s);
}
