import type { ButtonComponent } from '../../../contract/button';
import { Button as ShadcnButton } from '../button';

const VARIANT = { primary: 'default', secondary: 'secondary', ghost: 'ghost', danger: 'destructive' } as const;
const SIZE = { sm: 'sm', md: 'default', icon: 'icon' } as const;

export const Button: ButtonComponent = ({ variant = 'secondary', size = 'md', type = 'button', ...props }) => (
  <ShadcnButton variant={VARIANT[variant]} size={SIZE[size]} type={type} {...props} />
);
