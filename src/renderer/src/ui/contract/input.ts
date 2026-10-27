import type { ChangeEvent, ComponentType, KeyboardEvent, Ref } from 'react';

export interface InputProps {
  ref?: Ref<HTMLInputElement>;
  id?: string;
  value?: string;
  onChange?: (e: ChangeEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  spellCheck?: boolean;
  autoComplete?: string;
  /** compact variant for dense panels */
  size?: 'sm' | 'md';
}

export interface InputApi {
  Input: ComponentType<InputProps>;
}
