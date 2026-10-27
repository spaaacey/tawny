import { CornerDownLeft, File, Pause, Plus, X } from 'lucide-react';
import { type ComponentProps, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from '../ui/attachment';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ui/dialog';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from '../ui/input-group';

/** The bordered box: attachments on top, textarea, footer below; className is layout-only. */
export const PromptInput = ({ children, className }: { children?: ReactNode; className?: string }) => (
  // Wrap instead of stacking so the submit button stays beside the textarea when the attachments row is present.
  <InputGroup className={cn('flex-wrap has-[>[data-align=block-start]]:flex-row', className)}>{children}</InputGroup>
);

/** Attachment chips above the textarea; renders nothing when empty. */
export const PromptInputAttachments = ({
  items,
  onRemove,
}: {
  items: { src?: string; name?: string; video?: boolean }[];
  onRemove: (index: number) => void;
}) =>
  items.length ? (
    <InputGroupAddon align="block-start">
      <AttachmentGroup>
        {items.map((it, i) => (
          <Attachment key={i} size="xs" className="min-w-0">
            {it.src ? (
              <Dialog>
                <DialogTrigger asChild>
                  <AttachmentTrigger
                    aria-label={it.video ? 'Expand video' : 'Expand image'}
                    className="cursor-zoom-in"
                  />
                </DialogTrigger>
                <DialogContent className="w-auto max-w-[90vw] border-0 bg-transparent p-0 shadow-none sm:max-w-[90vw]">
                  <DialogTitle className="sr-only">{it.video ? 'Video' : 'Image'}</DialogTitle>
                  {it.video ? (
                    // biome-ignore lint/a11y/useMediaCaption: user-attached clip
                    <video src={it.src} controls autoPlay className="max-h-[90vh] max-w-[90vw] rounded-lg" />
                  ) : (
                    <img
                      src={it.src}
                      alt={it.name ?? ''}
                      className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
                    />
                  )}
                </DialogContent>
              </Dialog>
            ) : null}
            {it.src ? (
              <AttachmentMedia variant="image">
                {it.video ? (
                  <video src={`${it.src}#t=0.1`} muted preload="metadata" />
                ) : (
                  <img src={it.src} alt={it.name ?? ''} />
                )}
              </AttachmentMedia>
            ) : (
              <>
                <AttachmentMedia>
                  <File />
                </AttachmentMedia>
                <AttachmentContent className="max-w-40">
                  <AttachmentTitle title={it.name}>{it.name}</AttachmentTitle>
                </AttachmentContent>
              </>
            )}
            <AttachmentActions>
              <AttachmentAction aria-label={`Remove ${it.name ?? 'attachment'}`} onClick={() => onRemove(i)}>
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

/** "+" at the left of the textarea: opens a file picker. */
export const PromptInputAdd = ({ disabled, onFiles }: { disabled?: boolean; onFiles: (files: File[]) => void }) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <InputGroupAddon align="inline-start" className="self-end">
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <InputGroupButton
        size="icon-sm"
        variant="ghost"
        className="size-7 rounded-md"
        aria-label="Attach files"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Plus />
      </InputGroupButton>
    </InputGroupAddon>
  );
};

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
