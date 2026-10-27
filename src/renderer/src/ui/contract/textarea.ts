import type { ClipboardEventHandler, ComponentType, KeyboardEventHandler, MouseEventHandler, Ref } from 'react';

export interface TextareaProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  ref?: Ref<HTMLTextAreaElement>;
  /** `bare`: no border/background/focus ring, for embedding in a container that draws them */
  variant?: 'default' | 'bare';
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  spellCheck?: boolean;
  autoFocus?: boolean;
  'aria-label'?: string;
  onKeyDown?: KeyboardEventHandler<HTMLTextAreaElement>;
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  onClick?: MouseEventHandler<HTMLTextAreaElement>;
  onBlur?: () => void;
}

export type TextareaComponent = ComponentType<TextareaProps>;
