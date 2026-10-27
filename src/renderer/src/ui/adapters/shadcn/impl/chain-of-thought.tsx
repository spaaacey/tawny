import type { ChainOfThoughtApi } from '../../../contract/chain-of-thought';
import * as C from '../chain-of-thought';

export const ChainOfThought: ChainOfThoughtApi['ChainOfThought'] = C.ChainOfThought;
export const ChainOfThoughtHeader: ChainOfThoughtApi['ChainOfThoughtHeader'] = C.ChainOfThoughtHeader;
export const ChainOfThoughtContent: ChainOfThoughtApi['ChainOfThoughtContent'] = C.ChainOfThoughtContent;
export const ChainOfThoughtStep: ChainOfThoughtApi['ChainOfThoughtStep'] = C.ChainOfThoughtStep;
