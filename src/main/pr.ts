// PR review sessions: parse a PR ref, resolve it through `gh`, give it its own worktree on the PR head.
// Every gh call goes through `Gh`, which answers from a JSON fixture when TAWNY_GH_FIXTURE is set
// (see test/fixtures/gh/README.md), so dev verification never touches GitHub.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PrInfo } from '../shared/types';
import * as G from './git';
import type { Store } from './store';

export interface PrRef {
  host: string | null;
  owner: string | null;
  repo: string | null;
  number: number;
}

/** `https://host/o/r/pull/N[/...]` (GHE hosts too), `#N` or `N`. Number-only refs have no owner/repo (the current workspace's repo is used). */
export function parseRef(input: string): PrRef | null {
  const s = input.trim();
  const u = /^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(s);
  if (u) return { host: u[1], owner: u[2], repo: u[3], number: Number(u[4]) };
  const n = /^#?(\d+)$/.exec(s);
  if (n) return { host: null, owner: null, repo: null, number: Number(n[1]) };
  return null;
}

/** Tab key of a PR session's PR tab. */
export const prKey = (p: Pick<PrInfo, 'owner' | 'repo' | 'number'>) => `p:${p.owner}/${p.repo}#${p.number}`;
const idOf = (p: Pick<PrInfo, 'host' | 'owner' | 'repo' | 'number'>) => `${p.host}/${p.owner}/${p.repo}#${p.number}`;

/** `host/owner/repo` of a git remote URL (ssh scp-style, ssh:// or https), or null. */
export function parseRemote(url: string): { host: string; owner: string; repo: string } | null {
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/\s]+@)?([^/:\s]+)[/:](?:\d+\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
    url.trim(),
  );
  return m ? { host: m[1], owner: m[2], repo: m[3] } : null;
}

async function remotesOf(repo: string) {
  try {
    const out = await G.git(repo, ['remote', '-v']);
    const seen = new Set<string>();
    const list: { host: string; owner: string; repo: string }[] = [];
    for (const line of out.split('\n')) {
      const r = parseRemote(line.split(/\s+/)[1] || '');
      if (r && !seen.has(`${r.host}/${r.owner}/${r.repo}`)) {
        seen.add(`${r.host}/${r.owner}/${r.repo}`);
        list.push(r);
      }
    }
    return list;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ gh (real or fixture)

/** What `gh pr view --json number,title,state,isDraft,url,headRefOid,baseRefOid,reviewDecision` returns. */
interface GhPrView {
  number: number;
  title: string;
  state: string;
  isDraft?: boolean;
  url: string;
  headRefOid: string;
  baseRefOid: string;
  reviewDecision?: string;
}
const VIEW_FIELDS = 'number,title,state,isDraft,url,headRefOid,baseRefOid,reviewDecision';

interface FixturePr extends Partial<GhPrView> {
  /** local branch standing in for the PR head: the worktree is created from it instead of `gh pr checkout` */
  localBranch: string;
}
interface Fixture {
  /** `host/owner/repo#number` (host omitted = github.com) -> `gh pr view` JSON + localBranch */
  prs: Record<string, FixturePr>;
  /** GraphQL query responses by operation name (phase 2+) */
  graphql?: Record<string, unknown>;
}
/** Fixture mutations: operation name -> handler that updates the in-memory fixture and returns the response (phase 5+). */
const mutationHandlers: Record<string, (fx: Fixture, vars: Record<string, unknown>) => unknown> = {};

let fixture: Fixture | null | undefined;
/** In-memory fixture (loaded once per process; mutations edit this copy, never the file). */
function loadFixture(): Fixture | null {
  if (fixture !== undefined) return fixture;
  const f = process.env.TAWNY_GH_FIXTURE;
  fixture = f ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Fixture) : null;
  return fixture;
}

const stateOf = (v: GhPrView): PrInfo['state'] => {
  const s = v.state.toUpperCase();
  return s === 'MERGED'
    ? 'merged'
    : s === 'CLOSED'
      ? 'closed'
      : v.isDraft
        ? 'draft'
        : v.reviewDecision === 'APPROVED'
          ? 'approved'
          : 'open';
};

export class Gh {
  /** PR metadata. `repo` (host/owner/repo) is omitted for a number-only ref: gh resolves it from `cwd`. */
  async view(number: number, repo: string | null, cwd: string): Promise<GhPrView> {
    const fx = loadFixture();
    if (fx) {
      let key = repo;
      if (!key) {
        const r = (await remotesOf(cwd))[0];
        if (!r) throw new Error('This repository has no remote');
        key = `${r.host}/${r.owner}/${r.repo}`;
      }
      const e = fx.prs[`${key}#${number}`] ?? fx.prs[`${key.replace(/^github\.com\//, '')}#${number}`];
      if (!e) throw new Error(`gh fixture has no PR ${key}#${number}`);
      const { localBranch, ...view } = e;
      const head = view.headRefOid || (await G.git(cwd, ['rev-parse', localBranch])).trim();
      return {
        number,
        title: '',
        state: 'OPEN',
        url: `https://${key.split('/').length === 3 ? key : `github.com/${key}`}/pull/${number}`,
        baseRefOid: '',
        ...view,
        headRefOid: head,
      };
    }
    const args = ['pr', 'view', String(number), '--json', VIEW_FIELDS];
    if (repo) args.push('--repo', repo);
    return JSON.parse(await G.run('gh', args, { cwd, timeout: 30000 })) as GhPrView;
  }

  /** `gh api graphql`, or the fixture's canned response / mutation handler. Used by phase 2+. */
  async graphql(query: string, vars: Record<string, unknown>, cwd: string): Promise<unknown> {
    const fx = loadFixture();
    if (fx) {
      const m = /\b(query|mutation)\s+(\w+)/.exec(query);
      if (!m) throw new Error('gh fixture: GraphQL operations must be named');
      if (m[1] === 'mutation') {
        const h = mutationHandlers[m[2]];
        if (!h) throw new Error(`gh fixture: no mutation handler for ${m[2]}`);
        return h(fx, vars);
      }
      if (!fx.graphql || !(m[2] in fx.graphql)) throw new Error(`gh fixture: no response for ${m[2]}`);
      return structuredClone(fx.graphql[m[2]]);
    }
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
    return JSON.parse(await G.run('gh', args, { cwd, timeout: 30000 }));
  }
}

// ------------------------------------------------------------------ sessions

export interface OpenCtx {
  /** repo roots known to Tawny */
  repos: string[];
  /** repo root of the active workspace (resolves `#N`) */
  activeRepo: string | null;
  worktreeRoot: string;
  copyOnCreate: string[];
}

export class Pr {
  gh = new Gh();
  constructor(private store: Store) {}

  all() {
    return this.store.data.prSessions || {};
  }
  for(dir: string): PrInfo | undefined {
    return this.all()[dir];
  }
  forget(dir: string) {
    const all = this.store.data.prSessions;
    if (all?.[dir]) {
      delete all[dir];
      this.store.save();
    }
  }

  /** Open a PR review worktree for `input` (URL or #N). Reuses the existing one when this PR already has a session. */
  async open(input: string, ctx: OpenCtx): Promise<{ dir: string; pr: PrInfo; created: boolean }> {
    const ref = parseRef(input);
    if (!ref) throw new Error('Enter a PR URL (https://github.com/owner/repo/pull/123) or #123');
    // which local repo hosts the checkout
    let repo: string | null = null;
    if (ref.owner) {
      const cands = ctx.activeRepo ? [ctx.activeRepo, ...ctx.repos] : ctx.repos;
      for (const r of cands) {
        if ((await remotesOf(r)).some((x) => x.host === ref.host && x.owner === ref.owner && x.repo === ref.repo)) {
          repo = r;
          break;
        }
      }
      if (!repo)
        throw new Error(`No open repository has ${ref.host}/${ref.owner}/${ref.repo} as a remote. Add it first.`);
    } else {
      repo = ctx.activeRepo;
      if (!repo) throw new Error('Select a repository workspace first (needed to resolve #' + ref.number + ')');
    }
    const view = await this.gh.view(ref.number, ref.owner ? `${ref.host}/${ref.owner}/${ref.repo}` : null, repo);
    const u = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(view.url);
    if (!u) throw new Error(`Unexpected PR url from gh: ${view.url}`);
    const pr: PrInfo = {
      host: u[1],
      owner: u[2],
      repo: u[3],
      number: view.number,
      headSha: view.headRefOid,
      baseSha: view.baseRefOid,
      url: view.url,
      title: view.title,
      state: stateOf(view),
    };
    const have = Object.entries(this.all()).find(([d, p]) => idOf(p) === idOf(pr) && fs.existsSync(d));
    if (have) {
      this.all()[have[0]] = { ...pr };
      this.store.save();
      return { dir: have[0], pr, created: false };
    }
    const fx = loadFixture();
    let dir: string;
    const branch = `pr-${pr.number}`;
    if (fx) {
      const e =
        fx.prs[`${pr.host}/${pr.owner}/${pr.repo}#${pr.number}`] ?? fx.prs[`${pr.owner}/${pr.repo}#${pr.number}`];
      dir = await G.addWorktree(repo, e.localBranch, undefined, ctx.worktreeRoot);
    } else {
      dir = await G.addWorktree(repo, branch, 'HEAD', ctx.worktreeRoot);
      try {
        await G.run('gh', ['pr', 'checkout', String(pr.number), '--branch', branch, '--force'], {
          cwd: dir,
          timeout: 120000,
        });
      } catch (e) {
        await G.removeWorktree(repo, dir, true).catch(() => {});
        throw e;
      }
    }
    dir = fs.realpathSync(dir).replace(/[\\/]+$/, ''); // same form as `git worktree list`
    G.copyIntoWorktree(repo, dir, ctx.copyOnCreate);
    if (!this.store.data.prSessions) this.store.data.prSessions = {};
    this.store.data.prSessions[dir] = pr;
    this.store.save();
    return { dir, pr, created: true };
  }
}
