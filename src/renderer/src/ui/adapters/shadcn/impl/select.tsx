import type { SelectApi } from '../../../contract/select';
import * as S from '../select';

export const Select: SelectApi['Select'] = S.Select;
export const SelectValue: SelectApi['SelectValue'] = S.SelectValue;
export const SelectContent: SelectApi['SelectContent'] = S.SelectContent;
export const SelectItem: SelectApi['SelectItem'] = S.SelectItem;
export const SelectTrigger: SelectApi['SelectTrigger'] = (props) => <S.SelectTrigger className="w-full" {...props} />;
