import type { CheckboxApi } from '../../../contract/checkbox';
import * as C from '../checkbox';

export const Checkbox: CheckboxApi['Checkbox'] = ({ onCheckedChange, ...props }) => (
  <C.Checkbox onCheckedChange={(v) => onCheckedChange(v === true)} {...props} />
);
