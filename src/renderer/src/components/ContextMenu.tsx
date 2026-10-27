import { type ReactElement, useState } from 'react';
import {
  ContextMenuContent,
  ContextMenuTrigger,
  ContextMenuItem as MenuItem,
  ContextMenu as Root,
} from './ui/context-menu';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

/** Right-click menu on its single child. `items` as a function is evaluated each time the menu opens; `disabled` leaves native right-click alone. */
export function ContextMenu({
  items,
  disabled,
  children,
}: {
  items: ContextMenuItem[] | (() => ContextMenuItem[]);
  disabled?: boolean;
  children: ReactElement;
}) {
  const [list, setList] = useState<ContextMenuItem[]>([]);
  return (
    <Root onOpenChange={(open) => open && setList(typeof items === 'function' ? items() : items)}>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {list.map((it) => (
          <MenuItem key={it.label} onSelect={it.onSelect}>
            {it.label}
          </MenuItem>
        ))}
      </ContextMenuContent>
    </Root>
  );
}
