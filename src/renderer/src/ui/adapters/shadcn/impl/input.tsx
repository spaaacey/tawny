import { cn } from '@/lib/utils';
import type { InputApi } from '../../../contract/input';
import * as I from '../input';

export const Input: InputApi['Input'] = ({ size = 'md', ...props }) => (
  <I.Input className={cn(size === 'sm' && 'h-7 px-2 text-xs md:text-xs')} {...props} />
);
