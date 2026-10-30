import { focusedGroup, newTab, splitFocused } from '../components/workspace/layoutStore';

// Hold opt, tap Tab to cycle where the next tab opens (preview only); releasing opt creates it, Esc cancels.
const STOPS = ['right', 'bottom', 'left', 'top', 'center'] as const;
type Stop = (typeof STOPS)[number];

/** Install the picker's key handlers; returns the uninstall function. */
export function installSplitPicker() {
  let at = -1;
  let hint: HTMLElement | null = null;

  const end = () => {
    at = -1;
    hint?.remove();
    hint = null;
  };
  const show = (stop: Stop) => {
    const gid = focusedGroup();
    const r = gid ? document.querySelector<HTMLElement>(`.group[data-id="${gid}"]`)?.getBoundingClientRect() : null;
    if (!r) return;
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'drop-hint';
      document.body.appendChild(hint);
    }
    const w = stop === 'left' || stop === 'right' ? r.width / 2 : r.width;
    const h = stop === 'top' || stop === 'bottom' ? r.height / 2 : r.height;
    const x = stop === 'right' ? r.left + r.width / 2 : r.left;
    const y = stop === 'bottom' ? r.top + r.height / 2 : r.top;
    hint.style.cssText = `left:${x + 4}px;top:${y + 4}px;width:${w - 8}px;height:${h - 8}px`;
  };

  const down = (e: KeyboardEvent) => {
    if (at >= 0 && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return end();
    }
    if (e.code !== 'Tab' || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    at = (at + 1) % STOPS.length;
    show(STOPS[at]);
  };
  const up = (e: KeyboardEvent) => {
    if (e.key !== 'Alt' || at < 0) return;
    const stop = STOPS[at];
    end();
    if (stop === 'center') newTab();
    else splitFocused(stop);
  };

  addEventListener('keydown', down, true);
  addEventListener('keyup', up, true);
  addEventListener('blur', end);
  return () => {
    removeEventListener('keydown', down, true);
    removeEventListener('keyup', up, true);
    removeEventListener('blur', end);
    end();
  };
}
