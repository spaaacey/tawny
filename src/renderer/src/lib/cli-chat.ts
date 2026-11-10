// Renderer handlers for `tawny chat ...` (src/main/cli/chat.ts).
import { revealAgent } from '../components/workspace/layoutStore';
import { getApp } from '../store';
import { activate, focusTerm, refreshState } from './actions';
import { registerCliHandler } from './cli-bridge';

registerCliHandler<{ id: string; worktree: string }>('chat.focus', async ({ id, worktree }) => {
  await refreshState();
  if (getApp().active !== worktree) await activate(worktree);
  revealAgent(id);
  focusTerm(id);
  return { ok: true };
});
