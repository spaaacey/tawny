import { useState } from 'react';
import type { ContextMenuItem, ContextMenuProps } from '../../../contract/context-menu';
import { ContextMenu as CM, ContextMenuItem as CMItem, ContextMenuContent, ContextMenuTrigger } from '../context-menu';

export const ContextMenu = ({ items, disabled, children }: ContextMenuProps) => {
  const [list, setList] = useState<ContextMenuItem[]>([]);
  return (
    <CM onOpenChange={(open) => open && setList(typeof items === 'function' ? items() : items)}>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        {list.map((it) => (
          <CMItem key={it.label} onSelect={it.onSelect}>
            {it.label}
          </CMItem>
        ))}
      </ContextMenuContent>
    </CM>
  );
};
