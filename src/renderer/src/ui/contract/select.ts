import type { ComponentType, ReactNode } from 'react';

type Parts = { children?: ReactNode };

export interface SelectApi {
  Select: ComponentType<Parts & { value: string; onValueChange: (value: string) => void }>;
  SelectTrigger: ComponentType<Parts & { id?: string }>;
  SelectValue: ComponentType<{ placeholder?: string }>;
  SelectContent: ComponentType<Parts>;
  SelectItem: ComponentType<Parts & { value: string }>;
}
