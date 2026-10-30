import { cur, type Leaf, leafById, leaves, moveTab, type Side } from '../components/workspace/layoutStore';

// Hold opt, tap S to cycle where the active tab moves (preview only); releasing opt moves it, Esc cancels.
// Stops: the other panes in layout order, then new splits on sides with no neighbour, then back to the current pane (no-op).
type Stop = { kind: 'pane'; g: Leaf } | { kind: 'side'; side: Side } | { kind: 'self' };

const SIDES: Side[] = ['right', 'bottom', 'left', 'top'];
const rectOf = (id: string) => document.querySelector<HTMLElement>(`.group[data-id="${id}"]`)?.getBoundingClientRect();

function hasNeighbour(src: DOMRect, b: DOMRect, side: Side) {
  const rows = b.top < src.bottom && b.bottom > src.top;
  const cols = b.left < src.right && b.right > src.left;
  if (side === 'right') return rows && b.left >= src.right - 1;
  if (side === 'left') return rows && b.right <= src.left + 1;
  if (side === 'bottom') return cols && b.top >= src.bottom - 1;
  return cols && b.bottom <= src.top + 1;
}

function stopsFor(src: Leaf, panes: Leaf[]): Stop[] {
  const at = panes.indexOf(src);
  const others = [...panes.slice(at + 1), ...panes.slice(0, at)];
  const stops: Stop[] = others.map((g) => ({ kind: 'pane', g }));
  const r = rectOf(src.id);
  if (r && src.tabs.length > 1) {
    const rects = others.map((g) => rectOf(g.id)).filter((b): b is DOMRect => !!b);
    for (const side of SIDES) if (!rects.some((b) => hasNeighbour(r, b, side))) stops.push({ kind: 'side', side });
  }
  return stops.length ? [...stops, { kind: 'self' }] : [];
}

/** Install the picker's key handlers; returns the uninstall function. */
export function installMovePicker() {
  let stops: Stop[] = [];
  let at = -1;
  let hint: HTMLElement | null = null;

  const end = () => {
    at = -1;
    stops = [];
    hint?.remove();
    hint = null;
  };
  const show = (src: Leaf, stop: Stop) => {
    const r = rectOf(stop.kind === 'pane' ? stop.g.id : src.id);
    if (!r) return;
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'drop-hint';
      document.body.appendChild(hint);
    }
    const side = stop.kind === 'side' ? stop.side : null;
    const w = side === 'left' || side === 'right' ? r.width / 2 : r.width;
    const h = side === 'top' || side === 'bottom' ? r.height / 2 : r.height;
    const x = side === 'right' ? r.left + r.width / 2 : r.left;
    const y = side === 'bottom' ? r.top + r.height / 2 : r.top;
    hint.style.cssText = `left:${x + 4}px;top:${y + 4}px;width:${w - 8}px;height:${h - 8}px`;
  };

  const down = (e: KeyboardEvent) => {
    if (at >= 0 && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return end();
    }
    if (e.code !== 'KeyS' || !e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const lay = cur();
    const src = lay && leafById(lay, lay.focus);
    if (!lay || !src?.active) return;
    if (at < 0) stops = stopsFor(src, [...leaves(lay.tree)]);
    if (!stops.length) return;
    at = (at + 1) % stops.length;
    show(src, stops[at]);
  };
  const up = (e: KeyboardEvent) => {
    if (e.key !== 'Alt' || at < 0) return;
    const stop = stops[at];
    end();
    const lay = cur();
    const src = lay && leafById(lay, lay.focus);
    const key = src?.active;
    if (!src || !key) return;
    if (stop.kind === 'pane') moveTab(key, { kind: 'center', g: stop.g });
    else if (stop.kind === 'side') moveTab(key, { kind: 'edge', g: src, side: stop.side });
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
