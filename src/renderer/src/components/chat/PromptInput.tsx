import { ArrowUp, Square, X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia } from '../ui/attachment';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../ui/input-group';

/** The bordered box: attachments on top, textarea, footer below; className is layout-only. */
export const PromptInput = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <InputGroup className={className}>{children}</InputGroup>
);

/** Image chips above the textarea; renders nothing when empty. */
export const PromptInputAttachments = ({
  items,
  onRemove,
}: {
  items: { src: string; name?: string }[];
  onRemove: (index: number) => void;
}) =>
  items.length ? (
    <InputGroupAddon align="block-start">
      <AttachmentGroup>
        {items.map((it, i) => (
          <Attachment key={i} size="xs" className="min-w-0">
            <AttachmentMedia variant="image">
              <img src={it.src} alt={it.name ?? ''} />
            </AttachmentMedia>
            <AttachmentActions>
              <AttachmentAction aria-label="Remove image" onClick={() => onRemove(i)}>
                <X />
              </AttachmentAction>
            </AttachmentActions>
          </Attachment>
        ))}
      </AttachmentGroup>
    </InputGroupAddon>
  ) : null;

export const PromptInputTextarea = (props: ComponentProps<typeof InputGroupTextarea>) => (
  <InputGroupTextarea
    className="min-h-0 max-h-[220px] font-[family-name:var(--sans)] overflow-y-auto px-3 py-2.5 text-[13.5px] md:text-[13.5px]"
    {...props}
  />
);

/** Tools row under the textarea (children, left) and the submit button (right). */
export const PromptInputFooter = ({ children, submit }: { children?: ReactNode; submit: ReactNode }) => (
  <InputGroupAddon align="block-end" className="justify-between">
    <div className="flex min-w-0 items-center gap-1">{children}</div>
    {submit}
  </InputGroupAddon>
);

/** Send button, or stop when `stop` is set. */
export const PromptInputSubmit = ({
  stop,
  disabled,
  onClick,
}: {
  stop?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) => (
  <InputGroupButton
    size="icon-sm"
    variant={stop ? 'destructive' : 'default'}
    className="rounded-full"
    aria-label={stop ? 'Stop' : 'Send'}
    disabled={disabled}
    onClick={onClick}
  >
    {stop ? <Square className="size-3.5 fill-current" /> : <ArrowUp />}
  </InputGroupButton>
);
