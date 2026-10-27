import type { ComponentType } from 'react';

export interface ToastApi {
  /** Mount once; renders pushed toasts. */
  Toaster: ComponentType;
  /** Show a transient message for `ms` milliseconds. */
  showToast(msg: string, ms?: number): void;
}
