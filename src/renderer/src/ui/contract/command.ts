import type { ComponentType, KeyboardEvent, MouseEvent, ReactNode, Ref } from 'react';

type Parts = { children?: ReactNode };

export interface CommandApi {
  /** list with a search input; filtering is done by the app (items are rendered pre-filtered). `value` is the selected item's value. */
  Command: ComponentType<Parts & { value?: string; onValueChange?: (value: string) => void }>;
  CommandInput: ComponentType<{
    ref?: Ref<HTMLInputElement>;
    id?: string;
    value: string;
    onValueChange: (value: string) => void;
    placeholder?: string;
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  }>;
  CommandList: ComponentType<Parts>;
  CommandEmpty: ComponentType<Parts>;
  CommandItem: ComponentType<Parts & { value: string; onSelect?: () => void; onMouseDown?: (e: MouseEvent) => void }>;
}
