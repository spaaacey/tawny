// PR review sessions: parse a PR ref, resolve it through `gh`, give it its own worktree on the PR head.
// Every gh call goes through `Gh`, which answers from a JSON fixture when TAWNY_GH_FIXTURE is set
// (see test/fixtures/gh/README.md), so dev verification never touches GitHub.
import * as fs from 'node:fs';
import type {
  PrCommit,
  PrEdit,
  PrFiles,
  PrInfo,
  PrMoved,
  PrReview,
  PrReviewAction,
  PrReviewComment,
  PrReviewState,
  PrSnapshot,
  PrThread,
  PrTimelineItem,
  PrUser,
  PrVerdict,
} from '../shared/types';
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
  /** local branch standing in for the PR base: the merge-base for the PR files is taken against it */
  localBase?: string;
  /** local branch the PR head moves to on the next Refresh that sees a new head (the worktree is fast-forwarded/reset to it) */
  localBranchNext?: string;
}
interface Fixture {
  /** `host/owner/repo#number` (host omitted = github.com) -> `gh pr view` JSON + localBranch */
  prs: Record<string, FixturePr>;
  /** GraphQL query responses by operation name (phase 2+) */
  graphql?: Record<string, unknown>;
  /** in-memory pending review / resolutions, created on first use */
  state?: FxState;
}
/* biome-ignore-start lint/suspicious/noExplicitAny: raw GraphQL JSON */
/** In-memory state of the viewer's pending review and thread resolution under a fixture (never written to the file). */
interface FxState {
  init: boolean;
  seq: number;
  pending: { id: string; comments: FxComment[] } | null;
  /** reviews submitted under the fixture */
  submitted: { id: string; state: string; body: string; comments: FxComment[] }[];
  resolved: Record<string, boolean>;
  /** conversation comments posted under the fixture */
  comments?: string[];
  /** title / body / base edited under the fixture */
  edit?: { title: string; body: string; baseRefName: string };
}
interface FxComment {
  /** GraphQL comment node */
  node: Record<string, any>;
  /** thread it belongs to (an existing one, or a draft thread created here) */
  threadId: string;
  /** only for drafts that start a thread */
  thread?: { startLine: number | null; side: string };
}
/** Fixture mutations: operation name -> handler that updates the in-memory fixture and returns the response. */
const mutationHandlers: Record<string, (fx: Fixture, vars: Record<string, unknown>) => unknown> = {
  UpdatePr(fx, v) {
    fxState(fx).edit = { title: String(v.title), body: String(v.body), baseRefName: String(v.base) };
    return { data: { updatePullRequest: { pullRequest: { id: v.pr } } } };
  },
  AddReview(fx) {
    const st = fxState(fx);
    st.pending ??= { id: `PRR_pending_${++st.seq}`, comments: [] };
    return { data: { addPullRequestReview: { pullRequestReview: { id: st.pending.id } } } };
  },
  AddThread(fx, v) {
    const st = fxState(fx);
    if (!st.pending || st.pending.id !== v.review) throw new Error('gh fixture: no such pending review');
    const threadId = `PRRT_draft_${++st.seq}`;
    st.pending.comments.push({
      node: fxNode(`PRRC_draft_${st.seq}`, st.pending.id, String(v.body), String(v.path), Number(v.line)),
      threadId,
      thread: { startLine: v.startLine == null ? null : Number(v.startLine), side: String(v.side) },
    });
    return { data: { addPullRequestReviewThread: { thread: { id: threadId } } } };
  },
  AddComment(fx, v) {
    const st = fxState(fx);
    st.comments = [...(st.comments ?? []), String(v.body)];
    return { data: { addComment: { commentEdge: { node: { id: `IC_${++st.seq}` } } } } };
  },
  AddReply(fx, v) {
    const st = fxState(fx);
    if (!st.pending || st.pending.id !== v.review) throw new Error('gh fixture: no such pending review');
    const parent = findFxThread(fx, String(v.thread));
    st.pending.comments.push({
      node: fxNode(`PRRC_draft_${++st.seq}`, st.pending.id, String(v.body), parent.path, parent.line),
      threadId: String(v.thread),
    });
    return { data: { addPullRequestReviewThreadReply: { comment: { id: st.pending.comments.at(-1)?.node.id } } } };
  },
  EditComment(fx, v) {
    const c = fxState(fx).pending?.comments.find((x) => x.node.id === v.comment);
    if (!c) throw new Error('gh fixture: only pending comments can be edited');
    c.node.body = String(v.body);
    return { data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: c.node.id } } } };
  },
  DeleteComment(fx, v) {
    const st = fxState(fx);
    const i = st.pending?.comments.findIndex((x) => x.node.id === v.comment) ?? -1;
    if (!st.pending || i < 0) throw new Error('gh fixture: only pending comments can be deleted');
    st.pending.comments.splice(i, 1);
    return { data: { deletePullRequestReviewComment: { pullRequestReview: { id: st.pending.id } } } };
  },
  SubmitReview(fx, v) {
    const st = fxState(fx);
    if (!st.pending || st.pending.id !== v.review) throw new Error('gh fixture: no such pending review');
    const state = { COMMENT: 'COMMENTED', APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED' }[String(v.event)];
    if (!state) throw new Error(`gh fixture: bad event ${v.event}`);
    const id = `PRR_submitted_${++st.seq}`;
    for (const c of st.pending.comments) c.node.pullRequestReview = { id };
    st.submitted.push({ id, state, body: String(v.body ?? ''), comments: st.pending.comments });
    st.pending = null;
    return { data: { submitPullRequestReview: { pullRequestReview: { id, state } } } };
  },
  ResolveThread(fx, v) {
    fxState(fx).resolved[String(v.thread)] = true;
    return { data: { resolveReviewThread: { thread: { id: v.thread, isResolved: true } } } };
  },
  UnresolveThread(fx, v) {
    fxState(fx).resolved[String(v.thread)] = false;
    return { data: { unresolveReviewThread: { thread: { id: v.thread, isResolved: false } } } };
  },
};

function fxState(fx: Fixture): FxState {
  return (fx.state ??= { init: false, seq: 0, pending: null, submitted: [], resolved: {} });
}
const fxNode = (id: string, review: string, body: string, path: string, line: number) => ({
  id,
  body,
  createdAt: new Date().toISOString(),
  url: `https://github.com/fixture#discussion_${id}`,
  path,
  line,
  originalCommit: { oid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' },
  author: { login: 'chu', avatarUrl: 'https://github.com/chu.png' },
  pullRequestReview: { id: review },
});
function findFxThread(fx: Fixture, id: string) {
  const st = fxState(fx);
  const own = st.pending?.comments.find((c) => c.threadId === id);
  if (own) return { path: own.node.path as string, line: own.node.line as number };
  const arr = fx.graphql?.PrView;
  for (const snap of Array.isArray(arr) ? arr : [arr]) {
    for (const t of (snap as any)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
      if (t.id === id) return { path: t.path as string, line: (t.line ?? t.originalLine) as number };
  }
  throw new Error(`gh fixture: unknown thread ${id}`);
}

/** Overlay the fixture's in-memory pending review and resolutions onto a canned PrView response (the pending review in the file seeds it on first use). */
function fxOverlay(fx: Fixture, data: any) {
  const st = fxState(fx);
  const p = data?.data?.repository?.pullRequest;
  if (!p) return data;
  if (st.edit) Object.assign(p, st.edit);
  const reviews: any[] = p.reviews.nodes;
  const threads: any[] = p.reviewThreads.nodes;
  const seeded = reviews.find((r) => r.state === 'PENDING');
  if (!st.init) {
    st.init = true;
    if (seeded)
      st.pending = {
        id: seeded.id,
        comments: seeded.comments.nodes.map((n: any): FxComment => {
          const t = threads.find((x) => x.comments.nodes.some((c: any) => c.id === n.id));
          return {
            node: n,
            threadId: t?.id ?? `PRRT_seed_${n.id}`,
            thread: t ? undefined : { startLine: null, side: 'RIGHT' },
          };
        }),
      };
  }
  // drop the canned pending review (and its comments in threads), then draw the in-memory one
  p.reviews.nodes = reviews.filter((r) => r.state !== 'PENDING');
  for (const t of threads)
    t.comments.nodes = t.comments.nodes.filter((c: any) => c.pullRequestReview?.id !== seeded?.id);
  p.reviewThreads.nodes = threads.filter((t) => t.comments.nodes.length);
  const rt: any[] = p.reviewThreads.nodes;
  const place = (c: FxComment) => {
    let t = rt.find((x) => x.id === c.threadId);
    if (!t) {
      t = {
        id: c.threadId,
        path: c.node.path,
        line: c.node.line,
        startLine: c.thread?.startLine ?? null,
        originalLine: c.node.line,
        diffSide: c.thread?.side ?? 'RIGHT',
        isOutdated: false,
        isResolved: false,
        comments: { nodes: [] },
      };
      rt.push(t);
    }
    t.comments.nodes.push(c.node);
  };
  const me = { login: 'chu', avatarUrl: 'https://github.com/chu.png' };
  for (const r of st.submitted) {
    r.comments.forEach(place);
    p.reviews.nodes.push({
      id: r.id,
      state: r.state,
      body: r.body,
      createdAt: new Date().toISOString(),
      author: me,
      comments: { nodes: r.comments.map((c) => c.node) },
    });
    if (r.state !== 'COMMENTED') p.reviewDecision = r.state;
  }
  if (st.pending) {
    st.pending.comments.forEach(place);
    p.reviews.nodes.push({
      id: st.pending.id,
      state: 'PENDING',
      body: '',
      createdAt: new Date().toISOString(),
      author: me,
      comments: { nodes: st.pending.comments.map((c) => c.node) },
    });
  }
  for (const t of p.reviewThreads.nodes) if (t.id in st.resolved) t.isResolved = st.resolved[t.id];
  return data;
}

/* biome-ignore-end lint/suspicious/noExplicitAny: raw GraphQL JSON */

const gqlCalls: Record<string, number> = {};
let fixture: Fixture | null | undefined;
/** In-memory fixture (loaded once per process; mutations edit this copy, never the file). */
function loadFixture(): Fixture | null {
  if (fixture !== undefined) return fixture;
  const f = process.env.TAWNY_GH_FIXTURE;
  fixture = f ? (JSON.parse(fs.readFileSync(f, 'utf8')) as Fixture) : null;
  return fixture;
}

const stateOf = (v: Pick<GhPrView, 'state' | 'isDraft' | 'reviewDecision'>): PrInfo['state'] => {
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
      const { localBranch, localBase, ...view } = e;
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
      // `PrViewSync` (the re-fetch after a mutation) reads the canned PrView without advancing its snapshot counter
      const sync = m[2] === 'PrViewSync';
      const op = sync ? 'PrView' : m[2];
      if (!fx.graphql || !(op in fx.graphql)) throw new Error(`gh fixture: no response for ${m[2]}`);
      // an array = successive snapshots: first call returns [0], each next call the next one (last repeats), so Refresh can change state
      const r = fx.graphql[op];
      const over = (d: unknown) => (op === 'PrView' ? fxOverlay(fx, structuredClone(d)) : structuredClone(d));
      if (!Array.isArray(r)) return over(r);
      const i = Math.min(Math.max(0, (gqlCalls[op] ?? 0) - (sync ? 1 : 0)), r.length - 1);
      if (!sync) gqlCalls[op] = (gqlCalls[op] ?? 0) + 1;
      return over(r[i]);
    }
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [k, v] of Object.entries(vars))
      if (v != null) args.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`);
    return JSON.parse(await G.run('gh', args, { cwd, timeout: 30000 }));
  }
}

/** Comment body with a GitHub ```suggestion block appended. */
export const withSuggestion = (body: string, suggestion: string) =>
  `${body.trimEnd()}${body.trim() ? '\n\n' : ''}\`\`\`suggestion\n${suggestion.replace(/\n$/, '')}\n\`\`\``;

// ------------------------------------------------------------------ GraphQL snapshot

const USER = 'login avatarUrl';
const REVIEW_COMMENT = `id body createdAt url path line originalCommit { oid } author { ${USER} } pullRequestReview { id }`;
/** One query for everything the PR tab (and phases 3/5) needs. Pending reviews are only visible to their author, so the viewer's shows up in `reviews`. */
const prQuery = (name: string) => `query ${name}($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id number title url state isDraft reviewDecision body createdAt
      baseRefName headRefName baseRefOid headRefOid
      author { ${USER} }
      comments(first: 100) { nodes { id body createdAt url author { ${USER} } } }
      reviews(first: 100) {
        nodes { id state body createdAt author { ${USER} } comments(first: 100) { nodes { ${REVIEW_COMMENT} } } }
      }
      reviewThreads(first: 100) {
        nodes {
          id path line startLine originalLine diffSide isOutdated isResolved
          comments(first: 100) { nodes { ${REVIEW_COMMENT} } }
        }
      }
    }
  }
}`;
export const PR_QUERY = prQuery('PrView');
/** Same query re-run after a mutation (a separate name so fixtures can tell it apart). */
const PR_QUERY_SYNC = prQuery('PrViewSync');

/* biome-ignore-start lint/suspicious/noExplicitAny: raw GraphQL JSON */
const user = (u: any): PrUser | null => (u ? { login: u.login, avatarUrl: u.avatarUrl } : null);
const nodes = (c: any): any[] => c?.nodes ?? [];
const reviewComment = (c: any): PrReviewComment => ({
  id: c.id,
  author: user(c.author),
  body: c.body ?? '',
  createdAt: c.createdAt,
  url: c.url,
  path: c.path,
  line: c.line ?? null,
  originalCommit: c.originalCommit?.oid,
  reviewId: c.pullRequestReview?.id,
});

export function toSnapshot(data: any, now = Date.now()): PrSnapshot {
  const p = data?.data?.repository?.pullRequest;
  if (!p) throw new Error('Pull request not found (or no access)');
  const threads: PrThread[] = nodes(p.reviewThreads).map((t) => ({
    id: t.id,
    path: t.path,
    line: t.line ?? null,
    startLine: t.startLine ?? null,
    originalLine: t.originalLine ?? null,
    side: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    isOutdated: !!t.isOutdated,
    isResolved: !!t.isResolved,
    comments: nodes(t.comments).map(reviewComment),
  }));
  const reviews: any[] = nodes(p.reviews);
  const toReview = (r: any): PrReview => ({
    id: r.id,
    author: user(r.author),
    state: r.state as PrReviewState,
    body: r.body ?? '',
    createdAt: r.createdAt,
    comments: nodes(r.comments).map(reviewComment),
  });
  const pending = reviews.find((r) => r.state === 'PENDING');
  const timeline: PrTimelineItem[] = [
    ...nodes(p.comments).map(
      (c): PrTimelineItem => ({
        kind: 'comment',
        id: c.id,
        author: user(c.author),
        body: c.body ?? '',
        createdAt: c.createdAt,
        url: c.url,
      }),
    ),
    ...reviews
      .filter((r) => r.state !== 'PENDING')
      // a bare "commented" review with no body is only a wrapper for its inline threads
      .map(
        (r): PrTimelineItem => ({
          kind: 'review',
          id: r.id,
          author: user(r.author),
          body: r.body ?? '',
          createdAt: r.createdAt,
          state: r.state as PrReviewState,
          threadCount: nodes(r.comments).length,
        }),
      ),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return {
    fetchedAt: now,
    prId: p.id,
    title: p.title,
    number: p.number,
    url: p.url,
    state: p.state,
    isDraft: !!p.isDraft,
    reviewDecision: p.reviewDecision ?? null,
    author: user(p.author),
    baseRef: p.baseRefName,
    headRef: p.headRefName,
    baseSha: p.baseRefOid,
    headSha: p.headRefOid,
    createdAt: p.createdAt,
    body: p.body ?? '',
    viewer: data?.data?.viewer?.login ?? '',
    timeline,
    threads,
    pendingReview: pending ? toReview(pending) : null,
  };
}
/* biome-ignore-end lint/suspicious/noExplicitAny: raw GraphQL JSON */

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
      delete this.store.data.prSnapshots?.[dir];
      delete this.store.data.prFindings?.[dir];
      this.store.save();
    }
  }

  /** Snapshot of the PR reviewed in worktree `dir`: the stored one, or (`force` / none stored) a fresh GraphQL fetch that is stored and updates the PR's title/head/state. */
  async fetch(dir: string, force: boolean, sync = false): Promise<PrSnapshot> {
    const info = this.for(dir);
    if (!info) throw new Error('Not a PR review worktree');
    const cached = this.store.data.prSnapshots?.[dir];
    if (cached && !force) return cached;
    const data = await this.gh.graphql(
      sync ? PR_QUERY_SYNC : PR_QUERY,
      { owner: info.owner, repo: info.repo, number: info.number },
      dir,
    );
    const snap = toSnapshot(data);
    if (cached?.moved) snap.moved = cached.moved;
    if (cached?.syncWarn) snap.syncWarn = cached.syncWarn;
    if (!this.store.data.prSnapshots) this.store.data.prSnapshots = {};
    this.store.data.prSnapshots[dir] = snap;
    this.all()[dir] = {
      ...info,
      title: snap.title,
      headSha: snap.headSha,
      baseSha: snap.baseSha,
      state: stateOf({ state: snap.state, isDraft: snap.isDraft, reviewDecision: snap.reviewDecision ?? undefined }),
    };
    this.store.save();
    return snap;
  }

  /** Apply a draft / reply / edit / delete to the viewer's GitHub pending review, or resolve a thread; returns the re-fetched snapshot. Drafts are adopted from an existing pending review. */
  async review(dir: string, a: PrReviewAction): Promise<PrSnapshot> {
    const gql = (q: string, v: Record<string, unknown>) => this.gh.graphql(q, v, dir);
    if (a.kind === 'resolve') {
      await gql(
        a.resolved
          ? 'mutation ResolveThread($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }'
          : 'mutation UnresolveThread($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }',
        { thread: a.threadId },
      );
    } else if (a.kind === 'edit') {
      await gql(
        'mutation EditComment($comment: ID!, $body: String!) { updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $comment, body: $body}) { pullRequestReviewComment { id } } }',
        { comment: a.commentId, body: a.body },
      );
    } else if (a.kind === 'delete') {
      await gql(
        'mutation DeleteComment($comment: ID!) { deletePullRequestReviewComment(input: {id: $comment}) { pullRequestReview { id } } }',
        { comment: a.commentId },
      );
    } else {
      const review = await this.pendingReviewId(dir);
      if (a.kind === 'reply')
        await gql(
          'mutation AddReply($review: ID!, $thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }',
          { review, thread: a.threadId, body: a.body },
        );
      else {
        const body = a.side === 'RIGHT' && a.suggestion != null ? withSuggestion(a.body, a.suggestion) : a.body;
        const multi = a.startLine != null && a.startLine < a.line;
        await gql(
          'mutation AddThread($review: ID!, $path: String!, $line: Int!, $startLine: Int, $side: DiffSide!, $startSide: DiffSide, $body: String!) { addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, line: $line, startLine: $startLine, side: $side, startSide: $startSide, body: $body}) { thread { id } } }',
          {
            review,
            path: a.path,
            line: a.line,
            startLine: multi ? a.startLine : undefined,
            side: a.side,
            startSide: multi ? a.side : undefined,
            body,
          },
        );
      }
    }
    return this.fetch(dir, true, true);
  }

  /** Post a conversation comment on the PR (outside any review); returns the re-fetched snapshot. */
  async comment(dir: string, body: string): Promise<PrSnapshot> {
    let snap = await this.fetch(dir, false);
    if (!snap.prId) snap = await this.fetch(dir, true, true);
    if (!body.trim()) throw new Error('The comment is empty');
    await this.gh.graphql(
      'mutation AddComment($pr: ID!, $body: String!) { addComment(input: {subjectId: $pr, body: $body}) { commentEdge { node { id } } } }',
      { pr: snap.prId, body },
      dir,
    );
    return this.fetch(dir, true, true);
  }

  /** Edit the PR's title, description and base branch (author only); returns the re-fetched snapshot. */
  async edit(dir: string, e: PrEdit): Promise<PrSnapshot> {
    let snap = await this.fetch(dir, false);
    if (!snap.prId) snap = await this.fetch(dir, true, true);
    if (snap.author?.login !== snap.viewer) throw new Error('Only the PR author can edit it');
    if (!e.title.trim()) throw new Error('The title cannot be empty');
    if (!e.base.trim()) throw new Error('The base branch cannot be empty');
    await this.gh.graphql(
      'mutation UpdatePr($pr: ID!, $title: String!, $body: String!, $base: String!) { updatePullRequest(input: {pullRequestId: $pr, title: $title, body: $body, baseRefName: $base}) { pullRequest { id } } }',
      { pr: snap.prId, title: e.title.trim(), body: e.body, base: e.base.trim() },
      dir,
    );
    return this.fetch(dir, true, true);
  }

  /** Submit the viewer's pending review (starting an empty one when there are no drafts) with a verdict and summary; returns the re-fetched snapshot. */
  async submit(dir: string, verdict: PrVerdict, body: string): Promise<PrSnapshot> {
    const snap = await this.fetch(dir, false);
    const drafts = snap.pendingReview?.comments.length ?? 0;
    if (verdict !== 'APPROVE' && !drafts && !body.trim())
      throw new Error('Add a summary or at least one pending comment before submitting');
    const review = await this.pendingReviewId(dir);
    await this.gh.graphql(
      'mutation SubmitReview($review: ID!, $event: PullRequestReviewEvent!, $body: String) { submitPullRequestReview(input: {pullRequestReviewId: $review, event: $event, body: $body}) { pullRequestReview { id state } } }',
      { review, event: verdict, body: body.trim() || undefined },
      dir,
    );
    return this.fetch(dir, true, true);
  }

  dismissMoved(dir: string): PrSnapshot {
    const snap = this.store.data.prSnapshots?.[dir];
    if (!snap) throw new Error('No snapshot');
    delete snap.moved;
    this.store.save();
    return snap;
  }

  /** User Refresh: re-fetch; when the head moved (or an earlier update was blocked) bring the worktree to the new head and record what changed. */
  async refresh(dir: string): Promise<PrSnapshot> {
    const prev = this.store.data.prSnapshots?.[dir];
    const snap = await this.fetch(dir, true);
    if (!prev || (prev.headSha === snap.headSha && !prev.syncWarn)) return snap;
    delete snap.syncWarn;
    try {
      await this.syncWorktree(dir, snap);
    } catch (e) {
      snap.syncWarn = (e as Error).message;
    }
    this.store.save();
    return snap;
  }

  /** Move the PR worktree to the PR's new head (fast-forward, or reset after a force-push) and fill `snap.moved`. Refuses when it has uncommitted changes. */
  private async syncWorktree(dir: string, snap: PrSnapshot) {
    if ((await G.git(dir, ['status', '--porcelain'])).trim())
      throw new Error(
        'The PR has new commits, but this worktree has uncommitted changes. Commit or discard them, then Refresh.',
      );
    const before = (await G.git(dir, ['rev-parse', 'HEAD'])).trim();
    const fx = loadFixture();
    const info = this.for(dir);
    if (fx) {
      const e =
        info &&
        (fx.prs[`${info.host}/${info.owner}/${info.repo}#${info.number}`] ??
          fx.prs[`${info.owner}/${info.repo}#${info.number}`]);
      if (!e?.localBranchNext) return;
      const ff = await G.git(dir, ['merge-base', '--is-ancestor', 'HEAD', e.localBranchNext]).then(
        () => true,
        () => false,
      );
      await G.git(dir, ff ? ['merge', '--ff-only', e.localBranchNext] : ['reset', '--hard', e.localBranchNext]);
    } else {
      if (!info) return;
      // --force moves the PR branch to the new head even after a force-push
      const cur = (await G.git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      const branch = cur && cur !== 'HEAD' ? cur : `pr-${info.number}`;
      await G.run('gh', ['pr', 'checkout', String(info.number), '--branch', branch, '--force'], {
        cwd: dir,
        timeout: 120000,
      });
      const now = (await G.git(dir, ['rev-parse', 'HEAD'])).trim();
      if (now !== snap.headSha)
        throw new Error(`Worktree is at ${now.slice(0, 7)}, not the PR head ${snap.headSha.slice(0, 7)}`);
    }
    const to = (await G.git(dir, ['rev-parse', 'HEAD'])).trim();
    if (to === before) return;
    const from = snap.moved?.from && snap.moved.to === before ? snap.moved.from : before;
    const forced = await G.git(dir, ['merge-base', '--is-ancestor', before, to]).then(
      () => false,
      () => true,
    );
    const count = Number((await G.git(dir, ['rev-list', '--count', `${from}..${to}`]).catch(() => '0')).trim()) || 0;
    const latest = (await this.changed(dir, before)).map((f) => f.path);
    const moved: PrMoved = { from, to, count, forced, files: await this.changed(dir, from), latest };
    snap.moved = moved;
  }

  /** Id of the viewer's pending review, starting one if there is none (an existing one, even made on github.com, is adopted). */
  private async pendingReviewId(dir: string): Promise<string> {
    let snap = await this.fetch(dir, false);
    if (!snap.prId) snap = await this.fetch(dir, true, true);
    if (snap.pendingReview) return snap.pendingReview.id;
    try {
      const r = (await this.gh.graphql(
        'mutation AddReview($pr: ID!) { addPullRequestReview(input: {pullRequestId: $pr}) { pullRequestReview { id } } }',
        { pr: snap.prId },
        dir,
      )) as { data: { addPullRequestReview: { pullRequestReview: { id: string } } } };
      return r.data.addPullRequestReview.pullRequestReview.id;
    } catch (e) {
      // our snapshot was stale: a pending review exists already (one per user per PR), adopt it
      snap = await this.fetch(dir, true, true);
      if (snap.pendingReview) return snap.pendingReview.id;
      throw e;
    }
  }

  /** `git diff --name-status -M <from> HEAD` as a sorted file list. */
  private async changed(dir: string, from: string): Promise<PrFiles['files']> {
    const out = await G.git(dir, ['diff', '--name-status', '-z', '-M', from, 'HEAD']);
    const parts = out.split('\0');
    const files: PrFiles['files'] = [];
    for (let i = 0; i < parts.length; i++) {
      const st = parts[i];
      if (!st) continue;
      if (st[0] === 'R' || st[0] === 'C') {
        const orig = parts[++i];
        files.push({ path: parts[++i], status: st[0], orig });
      } else files.push({ path: parts[++i], status: st[0] });
    }
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  private async baseTarget(dir: string): Promise<string> {
    const info = this.for(dir);
    if (!info) throw new Error('Not a PR review worktree');
    const snap = this.store.data.prSnapshots?.[dir];
    const fx = loadFixture();
    const e =
      fx &&
      (fx.prs[`${info.host}/${info.owner}/${info.repo}#${info.number}`] ??
        fx.prs[`${info.owner}/${info.repo}#${info.number}`]);
    // the fixture's recorded shas aren't real: `localBase` is a local branch standing for the base
    const target = e?.localBase ?? (snap?.baseSha || info.baseSha);
    try {
      return (await G.git(dir, ['rev-parse', '--verify', `${target}^{commit}`])).trim();
    } catch {
      if (e || !snap?.baseRef) throw new Error('Could not find the PR base commit');
      await G.git(dir, ['fetch', 'origin', snap.baseRef]);
      return (await G.git(dir, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
    }
  }

  /** All commits reachable from the PR head but not the base, oldest first. No history cap. */
  async commits(dir: string): Promise<PrCommit[]> {
    // Ensures the base exists locally (including shallow / never-fetched base branches).
    const out = await G.git(dir, [
      'log',
      '--reverse',
      '--topo-order',
      '--format=%H%x00%h%x00%an%x00%s',
      `${await this.baseTarget(dir)}..HEAD`,
      '--',
    ]);
    return out
      .trimEnd()
      .split('\n')
      .filter(Boolean)
      .map((row) => {
        const [sha, short, author, subject] = row.split('\0');
        return { sha, short, author, subject };
      });
  }

  /** Files the PR changes against the merge-base of its base and the checked-out head. */
  async files(dir: string): Promise<PrFiles> {
    const info = this.for(dir);
    if (!info) throw new Error('Not a PR review worktree');
    const target = await this.baseTarget(dir);
    const base = (await G.git(dir, ['merge-base', target, 'HEAD'])).trim();
    const files = await this.changed(dir, base);
    return { base, files };
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
    const titleSlug = G.slug(pr.title.toLowerCase()).replace(/^wt$/, '').slice(0, 40).replace(/-+$/, '');
    const branch = titleSlug ? `pr-${pr.number}-${titleSlug}` : `pr-${pr.number}`;
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
