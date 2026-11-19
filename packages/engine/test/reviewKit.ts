import type { ContentBlock, WorkflowRun } from '@atlas/shared';
import type { ModelRequest } from '../src/providers/types.ts';
import { launch, eventually, setReviewAgent, type LaunchOptions } from './kit/index.ts';
import type { GhPr } from '../src/prs.ts';
import { mkdirSync } from 'node:fs';

/**
 * What the review tests share (#263): an engine whose PR reader and merge gate both talk to one fake GitHub, the
 * project's Review workflow started, and helpers to follow a task's Review run.
 */

export const URL = 'https://github.com/csoylu/atlas/pull/41';
export const HEAD = 'aaaaaaa1111';
export const use = (name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input }];
export const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
/** The reviewer's verdict through the real tool (merge: false, as the Review prompt says: step 5 merges). */
export const verdict = (v: 'ok' | 'fail', reason: string, o: { pr?: number; sha?: string } = {}) =>
  use('pr_validate', { pr: o.pr ?? 41, verdict: v, ...(v === 'ok' ? { sha: o.sha ?? HEAD, merge: false } : {}), reason });

/**
 * One GitHub for a repo: what Atlas's reader gets (`read`) and what the gate of validate.mjs asks (`gh`, REST), from
 * the same PR state; a merge or a status lands in it. `restHead`: the head the REST API says (a push after the review).
 */
export function fakeGitHub(repo = 'csoylu/atlas') {
  const g = {
    pr: { state: 'open', mergeSha: null, headSha: HEAD, branch: 'feat/170-x', base: 'main', mergeable: true, ci: 'pending', qa: null, qaDescription: null } as GhPr,
    restHead: null as string | null,
    down: null as string | null,
    reads: [] as string[],
    calls: [] as string[],
    read: async (r: string, n: number): Promise<GhPr> => {
      g.reads.push(`${r}#${n}`);
      if (r !== repo) throw new Error(`asked another repo: ${r}`);
      if (g.down) throw new Error(g.down);
      return { ...g.pr };
    },
    gh: async (args: string[]): Promise<string> => {
      g.calls.push(args.join(' '));
      if (g.down) throw new Error(g.down);
      const path = args[1]!;
      if (!path.startsWith(`repos/${repo}/`)) throw new Error(`asked another repo: ${path}`);
      if (/\/pulls\/\d+$/.test(path))
        return JSON.stringify({
          state: g.pr.state === 'open' ? 'open' : 'closed',
          merged: g.pr.state === 'merged',
          draft: false,
          mergeable: g.pr.mergeable,
          base: { ref: 'main', repo: { full_name: repo, default_branch: 'main' } },
          head: { sha: g.restHead ?? g.pr.headSha, ref: g.pr.branch, repo: { full_name: repo } },
        });
      if (path.includes('/check-runs')) {
        const ci = g.pr.ci;
        const runs = ci === null ? [] : [{ id: 1, name: 'test', status: ci === 'pending' ? 'in_progress' : 'completed', conclusion: ci === 'pending' ? null : ci, html_url: 'https://ci/1' }];
        return JSON.stringify({ check_runs: runs });
      }
      if (path.includes('/statuses/')) {
        const state = args.find((a) => a.startsWith('state='))?.slice(6);
        if (state === 'success' || state === 'failure') g.pr.qa = state;
        return '{}';
      }
      if (path.endsWith('/merge')) {
        g.pr = { ...g.pr, state: 'merged', mergeSha: 'e96a8e2ffff' };
        return JSON.stringify({ sha: 'e96a8e2ffff', merged: true });
      }
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    },
    merges: () => g.calls.filter((c) => c.includes('/merge')),
  };
  return g;
}
export type FakeGitHub = ReturnType<typeof fakeGitHub>;

type Turn = ContentBlock[] | ((req: ModelRequest) => ContentBlock[]);
/**
 * A script that tells the agents apart (the system prompt starts with the agent's name): the reviewer's turns from
 * `reviewer` in order, every other agent's turn is « fixing » (a task sent back to Ready wakes its builder at once).
 */
export function byAgent(reviewer: Turn[], reviewerId = 'zurich', n = 200): ((req: ModelRequest) => ContentBlock[])[] {
  const route = (req: ModelRequest): ContentBlock[] => {
    if (!req.system.includes(`You are "${reviewerId}"`)) return text('fixing');
    const t = reviewer.shift();
    if (!t) throw new Error(`the reviewer's script is exhausted`);
    return typeof t === 'function' ? t(req) : t;
  };
  return Array.from({ length: n }, () => route);
}

export const clock = { now: Date.now() };

export async function setupReview(o: { script?: LaunchOptions['script']; dbFile?: string; dataDir?: string; gh?: FakeGitHub; review?: boolean } = {}) {
  const gh = o.gh ?? fakeGitHub();
  const t = await launch({
    script: o.script ?? [],
    dispatch: false,
    ...(o.dbFile ? { dbFile: o.dbFile, dataDir: o.dataDir } : {}),
    prs: { read: gh.read, intervalMs: false, validate: { gh: gh.gh } },
    // A member's workspace of a project with a repo: an empty folder stands for the clone.
    projects: { clone: async (_repo, dir) => void mkdirSync(dir, { recursive: true }) },
  });
  const e = t.engine;
  for (const id of ['zurich', 'munih']) if (!e.agents.list().some((a) => a.id === id)) e.agents.create({ id, modelId: e.agents.get('atlas').modelId });
  e.settings.update({ triageAgent: 'atlas' });
  if (e.projects.get('atlas').reviewAgent !== 'zurich') setReviewAgent(e, 'atlas', 'zurich');
  // The poller's clock (the « can't read since » item waits 15 min).
  (e.prs as unknown as { now: () => number }).now = () => clock.now;
  // The review machinery the dispatcher starts in the app (dispatch: false here): workflows, then the Review seed.
  if (o.review !== false) startReview(e);
  return { ...t, e, gh };
}
export type E = Awaited<ReturnType<typeof setupReview>>['e'];

export function startReview(e: E): void {
  e.workflows.start(3_600_000);
  e.reviewFlow.start(3_600_000);
  e.prs.start();
}

export const card = (e: E, assignee = 'atlas', projectId?: string) =>
  e.kanban.create({ title: 'Workflows', status: 'ready', assignee, ...(projectId ? { projectId } : {}) }, 'user');

/** The task's latest workflow run (open or ended). */
export function lastRun(e: E, cardId: string): WorkflowRun | null {
  const r = e.db.prepare('SELECT id FROM workflow_runs WHERE subject_card = ? ORDER BY started_at DESC, rowid DESC LIMIT 1').get(cardId) as { id: string } | undefined;
  return r ? e.workflows.run(r.id) : null;
}
export const path = (r: WorkflowRun | null) => (r?.steps ?? []).map((s) => [s.nodeId, s.exit]);

/** Wait until the task's latest run ended. */
export const ended = (e: E, cardId: string, what = 'the Review run to end') =>
  eventually(
    () => {
      const r = lastRun(e, cardId);
      return r && r.state !== 'running' && r.state !== 'waiting' ? r : null;
    },
    { timeout: 10_000, what },
  );

/** Wait until the task's latest run is at a step (not ended). */
export const atStep = (e: E, cardId: string, nodeId: string) =>
  eventually(() => lastRun(e, cardId)?.steps?.find((s) => s.nodeId === nodeId && !s.endedAt) ?? null, { timeout: 10_000, what: `the Review run at « ${nodeId} »` });

export const notes = (e: E, cardId: string) => e.kanban.messages(cardId).filter((m) => m.author === 'workflow' || m.author === 'system');
export const lastNote = (e: E, cardId: string) => JSON.stringify(notes(e, cardId).at(-1)?.content ?? null);
export const inbox = (e: E, kind: string) =>
  e.db.prepare('SELECT title, body, card_id, archived_at FROM notifications WHERE kind = ? ORDER BY id').all(kind) as { title: string; body: string; card_id: string | null; archived_at: string | null }[];
