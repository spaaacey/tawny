import type { TextareaComponent } from '../../../contract/textarea';
import { Textarea as ShadcnTextarea } from '../textarea';

const BARE =
  'min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent text-[13.5px] md:text-[13.5px] leading-normal py-0.5 overflow-hidden';

export const Textarea: TextareaComponent = ({ variant = 'default', ...props }) => (
  <ShadcnTextarea
    className={variant === 'bare' ? BARE : 'resize-none font-[family-name:var(--sans)] md:text-sm'}
    {...props}
  />
);
