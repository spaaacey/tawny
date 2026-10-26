// @ts-nocheck -- ported as-is from the classic script; typing it is the remaining work
// Mouse-based drag helpers (HTML5 DnD is unreliable next to -webkit-app-region drag areas).
(() => {
  const THRESHOLD = 5;

  /** Run `onDrag(e)` once the mouse has moved past a small threshold; `onEnd(e, moved)` on release. */
  function track(e0, { onStart, onMove, onEnd }) {
    const sx = e0.clientX, sy = e0.clientY;
    let started = false;
    const mv = e => {
      if (!started) {
        if (Math.hypot(e.clientX - sx, e.clientY - sy) < THRESHOLD) return;
        started = true;
        document.body.classList.add('dnd-active');
        onStart && onStart(e);
      }
      onMove(e);
    };
    const up = e => {
      removeEventListener('mousemove', mv, true);
      removeEventListener('mouseup', up, true);
      removeEventListener('keydown', key, true);
      document.body.classList.remove('dnd-active');
      if (started) {
        // the click that follows a drag must not activate anything
        const swallow = ev => { ev.stopPropagation(); ev.preventDefault(); };
        addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => removeEventListener('click', swallow, true), 0);
      }
      onEnd(e, started, false);
    };
    const key = e => {
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
  function dock(handle, area, { getSide, setSide }) {
    handle.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      let target = null, overlay = null;
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
          for (const z of overlay.children) z.classList.toggle('on', z.dataset.side === target);
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
  function reorder(list, itemSel, keyOf, onMove, skipSel) {
    list.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const item = e.target.closest(itemSel);
      if (!item || (skipSel && e.target.closest(skipSel))) return;
      const key = keyOf(item);
      let slot = 0, bar = null;
      const items = () => [...list.querySelectorAll(itemSel)];
      const live = () => items().find(el => keyOf(el) === key);   // the item may be re-rendered mid-drag
      track(e, {
        onStart() {
          bar = document.createElement('div');
          bar.className = 'drop-bar';
          document.body.appendChild(bar);
          live()?.classList.add('dragging');
        },
        onMove(ev) {
          const all = items();
          slot = all.filter(el => { const r = el.getBoundingClientRect(); return ev.clientX > r.left + r.width / 2; }).length;
          const ref = slot < all.length ? all[slot].getBoundingClientRect() : all.length ? all[all.length - 1].getBoundingClientRect() : null;
          if (!ref) return;
          const x = slot < all.length ? ref.left - 1 : ref.right + 1;
          bar.style.cssText = `left:${x}px;top:${ref.top}px;height:${ref.height}px`;
        },
        onEnd(_ev, moved, cancelled) {
          if (bar) bar.remove();
          live()?.classList.remove('dragging');
          if (!moved || cancelled) return;
          const from = items().findIndex(el => keyOf(el) === key);
          if (from < 0) return;
          const to = slot > from ? slot - 1 : slot;
          if (to !== from) onMove(key, to);
        },
      });
    }, true);
  }

  window.harborDnd = { dock, reorder, track };
})();

export {};
