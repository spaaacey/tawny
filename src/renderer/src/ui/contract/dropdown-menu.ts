import type { ReactElement, ReactNode } from 'react';

export type DropdownItem =
  /** one-of-many choice; a menu's radio items share a single checked state */
  | {
      kind: 'radio';
      label: string;
      description?: string;
      icon?: ReactNode;
      checked: boolean;
      tone?: 'warn';
      onSelect: () => void;
    }
  | { kind: 'separator' }
  | { kind: 'label'; label: string }
  /** nested menu; value is the current choice, shown on the right */
  | { kind: 'sub'; label: string; value?: string; items: DropdownItem[] };

export interface DropdownMenuProps {
  /** the single element that opens the menu on click */
  trigger: ReactElement;
  items: DropdownItem[];
  disabled?: boolean;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
}
