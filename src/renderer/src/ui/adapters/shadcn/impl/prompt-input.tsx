import { ArrowUp, Square, X } from 'lucide-react';
import type { PromptInputApi } from '../../../contract/prompt-input';
import { Attachment, AttachmentAction, AttachmentActions, AttachmentGroup, AttachmentMedia } from '../attachment';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../input-group';

export const PromptInput: PromptInputApi['PromptInput'] = ({ children, className }) => (
  <InputGroup className={className}>{children}</InputGroup>
);

export const PromptInputAttachments: PromptInputApi['PromptInputAttachments'] = ({ items, onRemove }) =>
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

export const PromptInputTextarea: PromptInputApi['PromptInputTextarea'] = (props) => (
  <InputGroupTextarea
    className="min-h-0 max-h-[220px] font-[family-name:var(--sans)] overflow-y-auto px-3 py-2.5 text-[13.5px] md:text-[13.5px]"
    {...props}
  />
);

export const PromptInputFooter: PromptInputApi['PromptInputFooter'] = ({ children, submit }) => (
  <InputGroupAddon align="block-end" className="justify-between">
    <div className="flex min-w-0 items-center gap-1">{children}</div>
    {submit}
  </InputGroupAddon>
);

export const PromptInputSubmit: PromptInputApi['PromptInputSubmit'] = ({ stop, disabled, onClick }) => (
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
