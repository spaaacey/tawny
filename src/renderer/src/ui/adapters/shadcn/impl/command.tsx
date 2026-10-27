import type { CommandApi } from '../../../contract/command';
import * as C from '../command';

export const Command: CommandApi['Command'] = (props) => <C.Command shouldFilter={false} {...props} />;
export const CommandInput: CommandApi['CommandInput'] = (props) => (
  <C.CommandInput className="border-0 px-0" spellCheck={false} {...props} />
);
export const CommandList: CommandApi['CommandList'] = (props) => <C.CommandList className="max-h-[50vh]" {...props} />;
export const CommandEmpty: CommandApi['CommandEmpty'] = C.CommandEmpty;
export const CommandItem: CommandApi['CommandItem'] = C.CommandItem;
