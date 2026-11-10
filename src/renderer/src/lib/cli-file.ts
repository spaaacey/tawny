// Renderer handlers for `tawny file ...` (src/main/cli/file.ts). Main has validated the paths; here we open the tabs
// in the workspace's layout without stealing focus unless asked, and answer with the tab ids (`f:<path>`, `d:<mode>:<path>`).
import { openDiff as openDiffFocused, openFile, whenReady } from '../components/editor/api';
import { openDiff as openDiffQuiet, useLayoutStore } from '../components/workspace/layoutStore';
import { activate } from './actions';
import { registerCliHandler } from './cli-bridge';

interface Base {
  workspace: string;
  focus: boolean;
}

/** Tabs open in the layout's active workspace: switch to `workspace` when focusing, else refuse rather than steal focus. */
async function ensureActive({ workspace, focus }: Base) {
  const at = () => useLayoutStore.getState().root;
  if (at() === workspace) return;
  if (!focus)
    throw new Error(`${workspace} is not the active workspace; switch to it or pass --focus to open tabs there`);
  await activate(workspace);
  for (let i = 0; i < 40 && at() !== workspace; i++) await new Promise((r) => setTimeout(r, 50));
  if (at() !== workspace) throw new Error(`could not switch to ${workspace}`);
}

async function diff(mode: string, path: string, focus: boolean) {
  if (focus) await openDiffFocused(mode, path, { pin: true });
  else {
    await whenReady();
    await openDiffQuiet(mode, path, { focus: false, pin: true, background: true });
  }
  return `d:${mode}:${path}`;
}

registerCliHandler<Base & { path: string; line?: number }>('file.open', async (p) => {
  await ensureActive(p);
  await openFile(p.path, {
    pin: true,
    focus: p.focus,
    background: !p.focus,
    // revealing a line needs the tab on screen, so it only applies with --focus
    selection: p.focus && p.line ? { lineNumber: p.line, column: 1 } : undefined,
  });
  return `f:${p.path}`;
});

registerCliHandler<Base & { path: string; mode: string }>('file.diff', async (p) => {
  await ensureActive(p);
  return diff(p.mode, p.path, p.focus);
});

registerCliHandler<Base & { files: { path: string; mode: string }[] }>('file.open_changed', async (p) => {
  await ensureActive(p);
  const ids: string[] = [];
  for (const [i, f] of p.files.entries()) ids.push(await diff(f.mode, f.path, p.focus && i === 0));
  return ids;
});
