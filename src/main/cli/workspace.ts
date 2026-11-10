// `tawny workspace ...` and the shared `--workspace <path|name>` resolver (default: the caller's worktree).
import * as path from 'node:path';
import * as z from 'zod';
import type { CliCtx, Registry } from './registry';

export interface CliWorkspace {
  path: string;
  name: string;
  branch: string | null;
  /** main = a repo's main checkout, worktree = a linked one */
  kind: 'main' | 'worktree' | 'folder' | 'scratch';
  repo: string | null;
  active: boolean;
}

const valid = (list: CliWorkspace[]) => (list.length ? list.map((w) => `${w.name} (${w.path})`).join(', ') : 'none');

/** Resolve `spec` (absolute path or name) to a workspace; no spec means the caller's worktree. */
export function resolveWorkspace(list: CliWorkspace[], spec: string | undefined, ctx: CliCtx): CliWorkspace {
  const want = spec ?? ctx.worktree;
  if (!want) throw new Error(`no workspace: pass --workspace <path|name> (one of: ${valid(list)})`);
  const p = path.resolve(want).replace(/[\\/]+$/, '');
  const byPath = list.find((w) => w.path === p);
  if (byPath) return byPath;
  const byName = list.filter((w) => w.name === want);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1)
    throw new Error(
      `workspace name "${want}" is ambiguous, use a path (one of: ${byName.map((w) => w.path).join(', ')})`,
    );
  throw new Error(`unknown workspace "${want}"; valid values: ${valid(list)}`);
}

export function registerWorkspace(reg: Registry, list: () => CliWorkspace[]) {
  reg.add({
    name: 'workspace.list',
    summary: 'List workspaces: path, name, branch, kind, repo, active.',
    params: z.object({}),
    handler: () => list(),
  });
  reg.add({
    name: 'workspace.show',
    summary: 'Show one workspace (default: the current one).',
    params: z.object({ workspace: z.string().optional().describe('Workspace path or name') }),
    args: ['workspace'],
    handler: (p, ctx) => resolveWorkspace(list(), p.workspace, ctx),
  });
  reg.add({
    name: 'workspace.current',
    summary: 'Show the workspace this terminal or chat runs in.',
    params: z.object({}),
    handler: (_p, ctx) => resolveWorkspace(list(), undefined, ctx),
  });
}
