import type { ComponentType } from 'react';

export interface CheckboxApi {
  Checkbox: ComponentType<{
    id?: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    disabled?: boolean;
  }>;
}
