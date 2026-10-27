import type { ComponentType, ReactNode } from 'react';

export interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'icon';
  type?: 'button' | 'submit';
  disabled?: boolean;
  title?: string;
  autoFocus?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children?: ReactNode;
}

export type ButtonComponent = ComponentType<ButtonProps>;
