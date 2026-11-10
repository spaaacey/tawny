// TEMPORARY STUB (T4). T5 replaces this module with the real 'b' branch diff (left = merge-base, right = working tree).
// Until then: fall back to the working-tree diff, ignoring `line`.
import { openDiff } from './api';

export async function openBranchDiff(_root: string, absPath: string, opts?: { pin?: boolean; line?: number }) {
  await openDiff('w', absPath, opts?.pin ? { pin: true } : { preview: true });
}
