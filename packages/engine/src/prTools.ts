import { z } from 'zod';
import type { Card } from '@atlas/shared';
import type { ToolSpec } from './providers/types.ts';
import type { Db } from './store/db.ts';
import type { Kanban } from './kanban.ts';
import { projectRow } from './projects.ts';
import { ghBinary, ghClient, validate, type Gh } from '../../../scripts/pr/validate.mjs';

/**
 * pr_validate (#216): the PR validation gate, shipped with the engine so a reviewer can run it from any project's
 * workspace. It runs scripts/pr/validate.mjs's validate() in-process with the gate of the task's project (repo and
 * required CI check: Settings → Projects), as the reviewer (the status description says who). Only the task's
 * reviewer gets the tool, during a review of one of the task's own PRs. The gate is the same for every repo: base =
 * the default branch, ok needs the reviewed head sha, no conflict, the required check green; merge pins the merge to
 * the sha. A repo's own rules (Atlas's changelog entry) are checks its CI runs on the PR (#238), never code here: an
 * installed engine never lags behind a rule changed on main.
 */
export interface PrToolContext {
  db: Db;
  kanban: Kanban;
  agentId: string;
  cardId: string;
  /** The agent's shell environment (login PATH: gh). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Tests: a fake GitHub. */
  gh?: Gh;
}

const Validate = z
  .object({
    pr: z.number().int().positive().describe("the number of one of this task's pull requests"),
    verdict: z.enum(['ok', 'fail']),
    sha: z.string().regex(/^[0-9a-f]{7,40}$/i, 'a commit sha').optional().describe('ok: the head commit you checked (a commit pushed since is not validated)'),
    reason: z.string().trim().min(1).describe('ok: what you checked; fail: why, written for the builder (it becomes their note)'),
    merge: z.boolean().optional().describe('ok only: merge right after (default true); false sets the validation only'),
  })
  .refine((i) => i.verdict === 'fail' || i.sha, { message: 'verdict ok needs sha: the head commit you checked', path: ['sha'] })
  .refine((i) => i.verdict === 'ok' || !i.merge, { message: 'merge only goes with verdict ok', path: ['merge'] });

const SPECS = {
  pr_validate: {
    description:
      "Your verdict on this task's pull request, as its reviewer: sets the commit status qa/validated on its head with " +
      "the gate of the task's project (repo, required CI check) and, for ok, merges it (merge: false to only validate). " +
      "ok is refused, with the reason, while the required CI check is not green (the repo's own rules run there), the " +
      "head moved since the sha you give, the PR conflicts with its base or is not based on the repo's default branch. " +
      'fail sends the task back to its builder with your reason.',
    input: Validate,
  },
} as const;

export const isPrTool = (name: string): boolean => name in SPECS;

/** The tool, offered in a run on a task In review whose reviewer is this agent. */
export function prToolSpecs(card: Card, agentId: string): ToolSpec[] {
  if (card.status !== 'review' || card.reviewer !== agentId || !card.prs.length) return [];
  return Object.entries(SPECS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export async function runPrTool(name: string, input: unknown, ctx: PrToolContext): Promise<{ output: string; isError: boolean }> {
  try {
    if (name !== 'pr_validate') throw new Error(`unknown tool ${name}`);
    const parsed = Validate.safeParse(input);
    if (!parsed.success) return { output: `invalid input for pr_validate: ${parsed.error.issues.map((i) => i.message).join('; ')}`, isError: true };
    const i = parsed.data;
    const card = ctx.kanban.get(ctx.cardId);
    if (card.status !== 'review') throw new Error(`${ctx.kanban.ref(card.id)} is not in review: there is nothing to validate`);
    if (card.reviewer !== ctx.agentId) throw new Error(`you are not the reviewer of ${ctx.kanban.ref(card.id)} (@${card.reviewer ?? 'nobody'} is)`);
    if (card.assignee === ctx.agentId) throw new Error(`you built ${ctx.kanban.ref(card.id)}: someone else validates it`);
    const project = projectRow(ctx.db, card.projectId);
    if (!project.repo) throw new Error(`project ${project.name} has no GitHub repo: set it in Settings → Projects`);
    const pr = card.prs.find((p) => p.number === i.pr && p.repo.toLowerCase() === project.repo!.toLowerCase());
    if (!pr) throw new Error(`PR #${i.pr} of ${project.repo} is not linked to this task (its PRs: ${card.prs.map((p) => `${p.repo}#${p.number}`).join(', ')})`);

    const env = await ctx.env();
    const gh = ctx.gh ?? ghClient({ bin: ghBinary(), env });
    const verdict = i.verdict === 'ok' ? 'success' : 'failure';
    const out = await validate(
      { pr: pr.number, verdict, sha: i.sha ?? null, as: ctx.agentId, reason: i.reason, merge: verdict === 'success' && i.merge !== false, base: null, repo: project.repo, ciJob: project.ci_job },
      gh,
    );
    // The verdict, in the task's history: a workflow review step in this thread takes its exit from it (#273).
    ctx.kanban.event(card.id, 'pr_verdict', { by: ctx.agentId, verdict: i.verdict, pr: pr.number, sha: i.sha ?? null, reason: i.reason });
    return { output: out.join('\n'), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
