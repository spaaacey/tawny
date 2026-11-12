import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Mouse-based drag helpers (HTML5 DnD is unreliable next to -webkit-app-region drag areas).
export type Side = 'left' | 'right';
interface Track {
  onStart?(e: MouseEvent): void;
  onMove(e: MouseEvent): void;
  onEnd(e: MouseEvent | KeyboardEvent, moved: boolean, cancelled: boolean): void;
}

const THRESHOLD = 5;

/** Run `onDrag(e)` once the mouse has moved past a small threshold; `onEnd(e, moved)` on release. */
export function track(e0: MouseEvent, { onStart, onMove, onEnd }: Track) {
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
 * Drag the element behind `handle` to dock a panel on the left or right half of the element `#areaId`.
 * Render the returned node anywhere: it is the drop overlay (a portal into the area) while dragging.
 */
export function useDock(
  handle: RefObject<HTMLElement | null>,
  areaId: string,
  getSide: () => Side,
  setSide: (s: Side) => void,
  enabled = true,
) {
  const [target, setTarget] = useState<Side | null>(null);
  const [dragging, setDragging] = useState(false);
  const cb = useRef({ getSide, setSide });
  cb.current = { getSide, setSide };

  useEffect(() => {
    const el = handle.current;
    const area = document.getElementById(areaId);
    if (!enabled || !el || !area) return;
    const down = (e: MouseEvent) => {
      if (e.button !== 0) return;
      let t: Side | null = null;
      track(e, {
        onStart: () => setDragging(true),
        onMove(ev) {
          const r = area.getBoundingClientRect();
          t = ev.clientX < r.left + r.width / 2 ? 'left' : 'right';
          setTarget(t);
        },
        onEnd(_ev, moved, cancelled) {
          setDragging(false);
          setTarget(null);
          if (moved && !cancelled && t && t !== cb.current.getSide()) cb.current.setSide(t);
        },
      });
    };
    el.addEventListener('mousedown', down);
    return () => el.removeEventListener('mousedown', down);
  }, [handle, areaId, enabled]);

  const area = dragging ? document.getElementById(areaId) : null;
  return area
    ? createPortal(
        <div className="dock-overlay">
          <div data-side="left" className={target === 'left' ? 'on' : undefined} />
          <div data-side="right" className={target === 'right' ? 'on' : undefined} />
        </div>,
        area,
      )
    : null;
}

/** Items in saved order; unknown ids keep their natural order after the known ones. */
export function applyOrder<T>(items: T[], id: (t: T) => string, saved?: string[]): T[] {
  if (!saved?.length) return items;
  const rank = new Map(saved.map((x, i) => [x, i]));
  return items
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (rank.get(id(a.t)) ?? 1e6 + a.i) - (rank.get(id(b.t)) ?? 1e6 + b.i))
    .map((x) => x.t);
}

/**
 * Drag a `[data-rid]` row to reorder it among the rows of the same `[data-rgroup]` container.
 * Call from onMouseDown of the row; `commit(ids)` gets the new id order.
 */
export function startReorder(e: React.MouseEvent, row: HTMLElement, commit: (ids: string[]) => void) {
  if (e.button !== 0 || (e.target as HTMLElement).closest('button,input')) return;
  const group = row.closest<HTMLElement>('[data-rgroup]');
  if (!group) return;
  const rows = () => [...group.querySelectorAll<HTMLElement>(':scope > [data-rid]')];
  let at: { el: HTMLElement; after: boolean } | null = null;
  const clear = () => {
    for (const r of rows()) r.classList.remove('drop-before', 'drop-after', 'dragging');
  };
  track(e.nativeEvent, {
    onStart: () => row.classList.add('dragging'),
    onMove(ev) {
      for (const r of rows()) r.classList.remove('drop-before', 'drop-after');
      const others = rows().filter((r) => r !== row);
      let hit: typeof at = null;
      for (const r of others) {
        const b = r.getBoundingClientRect();
        if (ev.clientY < b.top + b.height / 2) {
          hit = { el: r, after: false };
          break;
        }
        hit = { el: r, after: true };
      }
      at = hit;
      if (hit) hit.el.classList.add(hit.after ? 'drop-after' : 'drop-before');
    },
    onEnd(_ev, moved, cancelled) {
      clear();
      if (!moved || cancelled || !at) return;
      const ids = rows()
        .filter((r) => r !== row)
        .map((r) => r.dataset.rid as string);
      const i = ids.indexOf(at.el.dataset.rid as string) + (at.after ? 1 : 0);
      ids.splice(i, 0, row.dataset.rid as string);
      commit(ids);
    },
  });
}
