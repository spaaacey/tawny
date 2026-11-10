// `tawny file open|diff|open-changed`: open file / diff tabs in the workspace. Main validates paths and reads git state;
// the renderer (`file.*` handlers in src/renderer/src/lib/cli-file.ts) opens the tabs and answers with their ids.
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as z from 'zod';
import type { Registry } from './registry';
import { type CliWorkspace, resolveWorkspace } from './workspace';

interface Change {
  path: string;
  status: string;
}
export interface FileDeps {
  workspaces(): CliWorkspace[];
  changes(root: string): Promise<{ staged: Change[]; unstaged: Change[] }>;
  request(method: string, params: unknown): Promise<unknown>;
}

/** Absolute path of `p` inside `root`, else an error. Relative paths resolve against the workspace. */
function inside(root: string, p: string) {
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`${p} is outside the workspace ${root}`);
  return abs;
}

export function registerFile(reg: Registry, d: FileDeps) {
  const workspace = z.string().optional().describe('Workspace path or name (default: the current one)');
  const focus = z.boolean().optional().describe('Switch to the tab (default: leave focus where it is)');

  reg.add({
    name: 'file.open',
    summary: 'Open a file in an editor tab. Prints the tab id.',
    params: z.object({
      path: z.string().describe('File path, absolute or relative to the workspace'),
      line: z.number().int().positive().optional().describe('Line to reveal'),
      workspace,
      focus,
    }),
    args: ['path'],
    handler: async (p, ctx) => {
      const ws = resolveWorkspace(d.workspaces(), p.workspace, ctx);
      const abs = inside(ws.path, p.path);
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) throw new Error(`no such file: ${abs}`);
      if (!st.isFile()) throw new Error(`not a file: ${abs}`);
      return d.request('file.open', { workspace: ws.path, path: abs, line: p.line, focus: !!p.focus });
    },
  });

  reg.add({
    name: 'file.diff',
    summary: 'Open the diff of a changed file (working tree, else staged) in a tab. Prints the tab id.',
    params: z.object({
      path: z.string().describe('File path, absolute or relative to the workspace'),
      workspace,
      focus,
    }),
    args: ['path'],
    handler: async (p, ctx) => {
      const ws = resolveWorkspace(d.workspaces(), p.workspace, ctx);
      const abs = inside(ws.path, p.path);
      const rel = path.relative(ws.path, abs);
      const { staged, unstaged } = await d.changes(ws.path);
      const mode = unstaged.some((c) => c.path === rel) ? 'w' : staged.some((c) => c.path === rel) ? 's' : null;
      if (!mode) throw new Error(`${rel} has no uncommitted changes in ${ws.name}`);
      return d.request('file.diff', { workspace: ws.path, path: abs, mode, focus: !!p.focus });
    },
  });

  reg.add({
    name: 'file.open_changed',
    summary: 'Open a diff tab for every changed file of the workspace. Prints the tab ids.',
    params: z.object({ workspace, focus }),
    handler: async (p, ctx) => {
      const ws = resolveWorkspace(d.workspaces(), p.workspace, ctx);
      const { staged, unstaged } = await d.changes(ws.path);
      const seen = new Set<string>();
      const files: { path: string; mode: string }[] = [];
      for (const [mode, list] of [
        ['w', unstaged],
        ['s', staged],
      ] as const)
        for (const c of list) {
          if (seen.has(c.path)) continue;
          seen.add(c.path);
          files.push({ path: path.join(ws.path, c.path), mode });
        }
      if (!files.length) return [];
      return d.request('file.open_changed', { workspace: ws.path, files, focus: !!p.focus });
    },
  });
}
