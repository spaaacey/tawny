import type { ComponentType, ReactNode } from 'react';

export interface StatusDotProps {
  /** waiting = pulsing attention dot, idle = filled, none = hollow */
  state: 'waiting' | 'idle' | 'none';
  /** smaller variant for nested rows */
  size?: 'md' | 'sm';
}

export interface SpinnerProps {
  size?: 'md' | 'sm';
}

export interface TooltipProps {
  content: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  children: ReactNode;
}

export interface UIProviderProps {
  children?: ReactNode;
}

export interface StatusApi {
  StatusDot: ComponentType<StatusDotProps>;
  Spinner: ComponentType<SpinnerProps>;
  Tooltip: ComponentType<TooltipProps>;
  /** App-level providers required by the ui layer (tooltips). Mount once at the root. */
  UIProvider: ComponentType<UIProviderProps>;
}
