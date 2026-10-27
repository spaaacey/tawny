// Mouse-based drag helpers (HTML5 DnD is unreliable next to -webkit-app-region drag areas).
type Side = 'left' | 'right';
interface Track {
  onStart?(e: MouseEvent): void;
  onMove(e: MouseEvent): void;
  onEnd(e: MouseEvent | KeyboardEvent, moved: boolean, cancelled: boolean): void;
}

const THRESHOLD = 5;

/** Run `onDrag(e)` once the mouse has moved past a small threshold; `onEnd(e, moved)` on release. */
function track(e0: MouseEvent, { onStart, onMove, onEnd }: Track) {
  const sx = e0.clientX,
    sy = e0.clientY;
  let started = false;
  const mv = (e: MouseEvent) => {
    if (!started) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < THRESHOLD) return;
      started = true;
      document.body.classList.add('dnd-active');
      onStart?.(e);
    }
    onMove(e);
  };
  const up = (e: MouseEvent) => {
    removeEventListener('mousemove', mv, true);
    removeEventListener('mouseup', up, true);
    removeEventListener('keydown', key, true);
    document.body.classList.remove('dnd-active');
    if (started) {
      // the click that follows a drag must not activate anything
      const swallow = (ev: Event) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener('click', swallow, true), 0);
    }
    onEnd(e, started, false);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    removeEventListener('mousemove', mv, true);
    removeEventListener('mouseup', up, true);
    removeEventListener('keydown', key, true);
    document.body.classList.remove('dnd-active');
    onEnd(e, started, true);
  };
  addEventListener('mousemove', mv, true);
  addEventListener('mouseup', up, true);
  addEventListener('keydown', key, true);
}

/**
 * Drag `handle` to dock `panel` on the left or right half of `area`.
 * `getSide()` returns 'left' | 'right'; `setSide(side)` applies it.
 */
function dock(
  handle: HTMLElement,
  area: HTMLElement,
  { getSide, setSide }: { getSide(): Side; setSide(s: Side): void },
) {
  handle.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    let target: Side | null = null;
    let overlay: HTMLElement | null = null;
    track(e, {
      onStart() {
        overlay = document.createElement('div');
        overlay.className = 'dock-overlay';
        overlay.innerHTML = '<div data-side="left"></div><div data-side="right"></div>';
        area.appendChild(overlay);
      },
      onMove(ev) {
        const r = area.getBoundingClientRect();
        target = ev.clientX < r.left + r.width / 2 ? 'left' : 'right';
        for (const z of (overlay as HTMLElement).children)
          z.classList.toggle('on', (z as HTMLElement).dataset.side === target);
      },
      onEnd(_ev, moved, cancelled) {
        if (overlay) overlay.remove();
        if (moved && !cancelled && target && target !== getSide()) setSide(target);
      },
    });
  });
}

/**
 * Make the children (`itemSel`) of `list` reorderable by dragging along the x axis.
 * `keyOf(el)` identifies an item; `onMove(key, index)` gets the final index in the list without the item.
 * Uses delegation, so it survives the list being re-rendered.
 */
function reorder(
  list: HTMLElement,
  itemSel: string,
  keyOf: (el: HTMLElement) => string,
  onMove: (key: string, index: number) => void,
  skipSel?: string,
) {
  list.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0) return;
      const t = e.target as HTMLElement;
      const item = t.closest<HTMLElement>(itemSel);
      if (!item || (skipSel && t.closest(skipSel))) return;
      const key = keyOf(item);
      let slot = 0;
      let bar: HTMLElement | null = null;
      const items = () => [...list.querySelectorAll<HTMLElement>(itemSel)];
      const live = () => items().find((el) => keyOf(el) === key); // the item may be re-rendered mid-drag
      track(e, {
        onStart() {
          bar = document.createElement('div');
          bar.className = 'drop-bar';
          document.body.appendChild(bar);
          live()?.classList.add('dragging');
        },
        onMove(ev) {
          const all = items();
          slot = all.filter((el) => {
            const r = el.getBoundingClientRect();
            return ev.clientX > r.left + r.width / 2;
          }).length;
          const ref =
            slot < all.length
              ? all[slot].getBoundingClientRect()
              : all.length
                ? all[all.length - 1].getBoundingClientRect()
                : null;
          if (!ref) return;
          const x = slot < all.length ? ref.left - 1 : ref.right + 1;
          (bar as HTMLElement).style.cssText = `left:${x}px;top:${ref.top}px;height:${ref.height}px`;
        },
        onEnd(_ev, moved, cancelled) {
          if (bar) bar.remove();
          live()?.classList.remove('dragging');
          if (!moved || cancelled) return;
          const from = items().findIndex((el) => keyOf(el) === key);
          if (from < 0) return;
          const to = slot > from ? slot - 1 : slot;
          if (to !== from) onMove(key, to);
        },
      });
    },
    true,
  );
}

export const harborDnd = { dock, reorder, track };
window.harborDnd = harborDnd;
