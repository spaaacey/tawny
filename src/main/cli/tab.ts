// `tawny tab ...`: list, focus and close the tabs of a workspace. The tab model lives in the renderer, so these go over the bridge.
import * as z from 'zod';
import type { Registry } from './registry';
import { type CliWorkspace, resolveWorkspace } from './workspace';

export function registerTab(
  reg: Registry,
  list: () => CliWorkspace[],
  request: (method: string, params: unknown) => Promise<unknown>,
) {
  const workspace = z.string().optional().describe('Workspace path or name (default: the current one)');
  const id = z.string().describe('Tab id: a chat or terminal session id (TAWNY_CHAT_ID), or a file/diff tab key');
  reg.add({
    name: 'tab.list',
    summary: 'List tabs of a workspace: id, kind, title, workspace, focused.',
    params: z.object({ workspace }),
    handler: (p, ctx) => request('tab.list', { workspace: resolveWorkspace(list(), p.workspace, ctx).path }),
  });
  reg.add({
    name: 'tab.focus',
    summary: 'Raise a tab and its workspace.',
    params: z.object({ id, workspace }),
    args: ['id'],
    handler: (p, ctx) => request('tab.focus', { id: p.id, workspace: resolveWorkspace(list(), p.workspace, ctx).path }),
  });
  reg.add({
    name: 'tab.close',
    summary: 'Close a tab.',
    params: z.object({ id, workspace }),
    args: ['id'],
    handler: (p, ctx) => request('tab.close', { id: p.id, workspace: resolveWorkspace(list(), p.workspace, ctx).path }),
  });
}
