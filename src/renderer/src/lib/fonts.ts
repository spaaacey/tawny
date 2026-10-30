import type { Settings } from '../../../shared/types';

const UI_BASE = 13;
const CHAT_BASE = 13.5;
const STATUSBAR_H = 24;

const clamp = (n: unknown, def: number) => (typeof n === 'number' && n >= 8 && n <= 32 ? n : def);

/** Push the UI/chat font settings into CSS vars: families replace --sans, sizes become zoom factors on the sidebar,
 *  pane tab bars and status bar (UI) or the chat view, since sizes are hardcoded px throughout the stylesheet. */
export function applyFonts(s: Settings) {
  const root = document.documentElement.style;
  const set = (k: string, v: string) => (v ? root.setProperty(k, v) : root.removeProperty(k));
  const ui = clamp(s.uiFontSize, UI_BASE) / UI_BASE;
  set('--ui-font', s.uiFontFamily?.trim());
  set('--chat-font', s.chatFontFamily?.trim());
  root.setProperty('--ui-zoom', String(ui));
  root.setProperty('--chat-zoom', String(clamp(s.chatFontSize, CHAT_BASE) / CHAT_BASE));
  root.setProperty('--statusbar-h', `${Math.round(STATUSBAR_H * ui)}px`);
}
