import type { ReactElement, ReactNode } from 'react';
import {
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenu as Root,
} from './ui/dropdown-menu';

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

function Items({ items }: { items: DropdownItem[] }) {
  const checked = items.findIndex((x) => x.kind === 'radio' && x.checked);
  return (
    <DropdownMenuRadioGroup value={String(checked)}>
      {items.map((x, i) => {
        if (x.kind === 'separator') return <DropdownMenuSeparator key={`sep${i}`} />;
        if (x.kind === 'label') return <DropdownMenuLabel key={x.label}>{x.label}</DropdownMenuLabel>;
        if (x.kind === 'sub')
          return (
            <DropdownMenuSub key={x.label}>
              <DropdownMenuSubTrigger>
                <span className="flex-1">{x.label}</span>
                {x.value ? <span className="text-muted-foreground text-xs">{x.value}</span> : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <Items items={x.items} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        return (
          <DropdownMenuRadioItem
            key={x.label}
            value={String(i)}
            className={x.tone === 'warn' ? 'text-[var(--work)]' : undefined}
            onSelect={x.onSelect}
          >
            {x.icon}
            <span className="flex flex-col gap-0.5">
              <b className="font-medium">{x.label}</b>
              {x.description ? <small className="text-muted-foreground text-[11.5px]">{x.description}</small> : null}
            </span>
          </DropdownMenuRadioItem>
        );
      })}
    </DropdownMenuRadioGroup>
  );
}

export function DropdownMenu({ trigger, items, disabled, align = 'start', side = 'bottom' }: DropdownMenuProps) {
  return (
    <Root>
      <DropdownMenuTrigger asChild disabled={disabled}>
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} side={side} className="min-w-64">
        <Items items={items} />
      </DropdownMenuContent>
    </Root>
  );
}
