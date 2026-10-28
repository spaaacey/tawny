// The editor / tab-bar context menu (one level of submenus). Opened imperatively through `showContextMenu`.
import { useLayoutEffect, useRef } from 'react';
import { create } from 'zustand';

export type MenuItem = { label: string; run?(): void; sub?: MenuItem[]; color?: string };

interface MenuState {
  menu: { x: number; y: number; items: MenuItem[] } | null;
  sub: { row: HTMLElement; items: MenuItem[] } | null;
}
const useMenu = create<MenuState>(() => ({ menu: null, sub: null }));

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  useMenu.setState({ menu: { x, y, items }, sub: null });
}
const close = () => useMenu.setState({ menu: null, sub: null });

const place = (el: HTMLElement, px: number, py: number) => {
  el.style.left = `${Math.max(6, Math.min(px, innerWidth - el.offsetWidth - 6))}px`;
  el.style.top = `${Math.max(6, Math.min(py, innerHeight - el.offsetHeight - 6))}px`;
};

function Rows({
  items,
  onEnter,
  onPick,
}: {
  items: MenuItem[];
  onEnter?: (it: MenuItem, el: HTMLElement) => void;
  onPick: (it: MenuItem, el: HTMLElement) => void;
}) {
  return items.map((it) => (
    <div
      key={it.label}
      className={`ci${it.sub ? ' has-sub' : ''}`}
      onMouseEnter={(e) => onEnter?.(it, e.currentTarget)}
      onClick={(e) => onPick(it, e.currentTarget)}
    >
      {it.color && <span className="cdot" style={{ background: it.color }} />}
      {it.label}
    </div>
  ));
}

export function ContextMenu() {
  const { menu, sub } = useMenu();
  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const openSub = (it: MenuItem, row: HTMLElement) => useMenu.setState({ sub: it.sub ? { row, items: it.sub } : null });

  useLayoutEffect(() => {
    if (menu && menuRef.current) place(menuRef.current, menu.x, menu.y);
  }, [menu]);
  useLayoutEffect(() => {
    const el = subRef.current;
    if (!sub || !el || !menuRef.current) return;
    const r = sub.row.getBoundingClientRect();
    const mr = menuRef.current.getBoundingClientRect();
    place(el, r.right + 2 + el.offsetWidth > innerWidth ? mr.left - el.offsetWidth - 2 : mr.right + 2, r.top - 5);
  }, [sub]);
  useLayoutEffect(() => {
    if (!menu) return;
    const outside = (ev: MouseEvent) => {
      const t = ev.target as Node;
      if (!menuRef.current?.contains(t) && !subRef.current?.contains(t)) close();
    };
    document.addEventListener('mousedown', outside, true);
    return () => document.removeEventListener('mousedown', outside, true);
  }, [menu]);

  if (!menu) return null;
  return (
    <>
      <div id="ctxMenu" ref={menuRef}>
        <Rows
          items={menu.items}
          onEnter={(it, el) => openSub(it, el)}
          onPick={(it, el) => {
            if (it.sub) return openSub(it, el);
            close();
            it.run?.();
          }}
        />
      </div>
      {sub && (
        <div id="ctxSub" ref={subRef}>
          <Rows
            items={sub.items}
            onPick={(it) => {
              close();
              it.run?.();
            }}
          />
        </div>
      )}
    </>
  );
}
