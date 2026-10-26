import type { AnyWorkspace, AppState, Session } from '../../../shared/types';

/** Sidebar order: plain workspaces first, then each repo's worktrees. */
export const allWorkspaces = (s: AppState): AnyWorkspace[] => [
  ...s.workspaces.map((w) => ({ ...w, repoName: '' }) as AnyWorkspace),
  ...s.repos.flatMap((r) => r.worktrees.map((w) => ({ ...w, repoName: r.name }) as AnyWorkspace)),
];

export const activeWorkspace = (s: AppState) => allWorkspaces(s).find((w) => w.path === s.active);

export const sessionsFor = (s: AppState, w: { prefix: string }): Session[] =>
  s.sessions.filter((x) => x.prefix === w.prefix).sort((a, b) => a.index - b.index);

export const workspaceLabel = (w: AnyWorkspace): string =>
  w.name || w.branch || (w.detached ? `detached ${w.head?.slice(0, 7)}` : w.path.split('/').pop() || w.path);

export const basename = (p: string) => p.split('/').pop() || p;
