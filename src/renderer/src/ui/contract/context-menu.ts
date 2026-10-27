import type { ReactElement } from 'react';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
}

export interface ContextMenuProps {
  /** a function is evaluated each time the menu opens */
  items: ContextMenuItem[] | (() => ContextMenuItem[]);
  /** when true the native right-click behavior is left alone */
  disabled?: boolean;
  /** the single element that opens the menu on right-click */
  children: ReactElement;
}
