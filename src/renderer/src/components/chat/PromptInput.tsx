import { CornerDownLeft, Pause, X } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTrigger,
} from '../ui/attachment';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../ui/input-group';

/** The bordered box: attachments on top, textarea, footer below; className is layout-only. */
export const PromptInput = ({ children, className }: { children?: ReactNode; className?: string }) => (
  // Wrap instead of stacking so the submit button stays beside the textarea when the attachments row is present.
  <InputGroup className={cn('flex-wrap has-[>[data-align=block-start]]:flex-row', className)}>{children}</InputGroup>
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
            <Dialog>
              <DialogTrigger asChild>
                <AttachmentTrigger aria-label="Expand image" className="cursor-zoom-in" />
              </DialogTrigger>
              <DialogContent className="w-auto max-w-[90vw] border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
                <DialogTitle className="sr-only">Image</DialogTitle>
                <img src={it.src} alt={it.name ?? ''} className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain" />
              </DialogContent>
            </Dialog>
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
    className="min-h-0 min-w-0 flex-1 basis-0 max-h-[220px] font-[family-name:var(--sans)] overflow-y-auto px-3 py-2.5 text-[13.5px] md:text-[13.5px]"
    {...props}
  />
);

/** Submit button, inline at the right of the textarea. */
export const PromptInputFooter = ({ submit }: { submit: ReactNode }) => (
  <InputGroupAddon align="inline-end" className="self-end">
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
    variant="ghost"
    className="size-7 rounded-md bg-[color-mix(in_srgb,var(--text)_22%,transparent)] text-[var(--text)] hover:bg-[color-mix(in_srgb,var(--text)_30%,transparent)] hover:text-[var(--text)] disabled:bg-[color-mix(in_srgb,var(--text)_8%,transparent)] disabled:text-[var(--faint)] disabled:opacity-100"
    aria-label={stop ? 'Stop' : 'Send'}
    disabled={disabled}
    onClick={onClick}
  >
    {stop ? <Pause className="size-3.5 fill-current" /> : <CornerDownLeft />}
  </InputGroupButton>
);
