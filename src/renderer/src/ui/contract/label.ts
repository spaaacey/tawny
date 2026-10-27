import type { ComponentType, ReactNode } from 'react';

export interface LabelApi {
  Label: ComponentType<{ htmlFor?: string; children?: ReactNode }>;
}
