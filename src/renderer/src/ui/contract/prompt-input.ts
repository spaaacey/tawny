import type { ComponentType, ReactNode } from 'react';
import type { TextareaProps } from './textarea';

export interface PromptInputApi {
  /** the bordered box: attachments on top, textarea, footer below; className is layout-only */
  PromptInput: ComponentType<{ children?: ReactNode; className?: string }>;
  /** image chips above the textarea; renders nothing when empty */
  PromptInputAttachments: ComponentType<{
    items: { src: string; name?: string }[];
    onRemove: (index: number) => void;
  }>;
  PromptInputTextarea: ComponentType<Omit<TextareaProps, 'variant'>>;
  /** tools row under the textarea (children, left) and the submit button (right) */
  PromptInputFooter: ComponentType<{ children?: ReactNode; submit: ReactNode }>;
  /** send button, or stop when `stop` is set */
  PromptInputSubmit: ComponentType<{ stop?: boolean; disabled?: boolean; onClick: () => void }>;
}
