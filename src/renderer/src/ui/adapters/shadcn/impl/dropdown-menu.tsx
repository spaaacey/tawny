import type { ComponentType } from 'react';
import type { DropdownItem, DropdownMenuProps } from '../../../contract/dropdown-menu';
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
} from '../dropdown-menu';

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

export const DropdownMenu: ComponentType<DropdownMenuProps> = ({
  trigger,
  items,
  disabled,
  align = 'start',
  side = 'bottom',
}) => (
  <Root>
    <DropdownMenuTrigger asChild disabled={disabled}>
      {trigger}
    </DropdownMenuTrigger>
    <DropdownMenuContent align={align} side={side} className="min-w-64">
      <Items items={items} />
    </DropdownMenuContent>
  </Root>
);
