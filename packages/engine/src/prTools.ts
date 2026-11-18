import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Card } from '@atlas/shared';
import type { ToolSpec } from './providers/types.ts';
import type { Db } from './store/db.ts';
import type { Kanban } from './kanban.ts';
import { projectRow } from './projects.ts';
import { ghBinary, ghClient, validate, type Gh, type ValidateDeps } from '../../../scripts/pr/validate.mjs';
import { rebaseChangelogOnly } from '../../../scripts/pr/rebase-changelog.mjs';

/**
 * pr_validate (#216): the PR validation gate, shipped with the engine so a reviewer can run it from any project's
 * workspace. It runs scripts/pr/validate.mjs's validate() in-process with the gate of the task's project (repo, CI
 * job, changelog rule: Settings → Projects), as the reviewer (the status description says who). Only the task's
 * reviewer gets the tool, during a review of one of the task's own PRs. Atlas's rules are the same as the script's:
 * --ok needs the reviewed head sha, merge pins the merge to it, a changelog-only conflict is rebased by itself (in the
 * reviewer's clone of the repo, found in its workspace) and merged once CI is green on the new head.
 */
export interface PrToolContext {
  db: Db;
  kanban: Kanban;
  agentId: string;
  cardId: string;
  workdir: string;
  signal: AbortSignal;
  /** The agent's shell environment (login PATH: gh and git; git author = the agent). */
  env: () => Promise<NodeJS.ProcessEnv>;
  /** Tests: a fake GitHub and rebase. */
  gh?: Gh;
  rebase?: ValidateDeps['rebase'];
  wait?: ValidateDeps['wait'];
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
      "the gate of the task's project (repo, required CI check, changelog entry if the project asks for one) and, for ok, " +
      'merges it (merge: false to only validate). ok is refused, with the reason, while CI is not green, the head moved ' +
      'since the sha you give, the PR conflicts with its base (a changelog-only conflict is rebased by itself where the ' +
      'project has a changelog) or the changelog rule fails. fail sends the task back to its builder with your reason.',
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
  const lines: string[] = [];
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
    const changelog = project.changelog === 1;
    const verdict = i.verdict === 'ok' ? 'success' : 'failure';
    const out = await validate(
      { pr: pr.number, verdict, sha: i.sha ?? null, as: ctx.agentId, reason: i.reason, merge: verdict === 'success' && i.merge !== false, base: 'main', repo: project.repo, ciJob: project.ci_job, changelog },
      gh,
      {
        log: (l) => lines.push(l),
        wait: { sleep: (ms) => sleep(ms, ctx.signal), ...ctx.wait },
        rebase:
          ctx.rebase ??
          (async (a) => {
            const repo = await findClone(ctx.workdir, project.repo!, env);
            return rebaseChangelogOnly({ repo, env, ...a });
          }),
      },
    );
    // validate() logs the auto-rebase lines and returns them too: show each once.
    return { output: [...lines.filter((l) => !out.includes(l)), ...out].join('\n'), isError: false };
  } catch (e) {
    return { output: [...lines, e instanceof Error ? e.message : String(e)].join('\n'), isError: true };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('stopped while waiting for CI'));
    const t = setTimeout(() => (signal.removeEventListener('abort', stop), resolve()), ms);
    const stop = () => (clearTimeout(t), reject(new Error('stopped while waiting for CI')));
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** owner/name of a git remote url (git@github.com:o/n.git, https://github.com/o/n, ssh://…), lower case; null if not GitHub. */
export function repoOfUrl(url: string): string | null {
  const m = url.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * The reviewer's clone of `repo` for the changelog-only rebase: the workspace itself or a folder right inside it whose
 * origin is the repo. None: a clear error (the rebase needs one; nothing is cloned behind the agent's back).
 */
export async function findClone(workdir: string, repo: string, env: NodeJS.ProcessEnv): Promise<string> {
  const dirs = [workdir, ...(existsSync(workdir) ? readdirSync(workdir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => join(workdir, d.name)) : [])];
  for (const dir of dirs) {
    if (!existsSync(join(dir, '.git'))) continue;
    const url = await new Promise<string | null>((resolve) =>
      execFile('git', ['-C', dir, 'remote', 'get-url', 'origin'], { env, timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout))),
    );
    if (url && repoOfUrl(url) === repo.toLowerCase()) return dir;
  }
  throw new Error(`the changelog-only rebase needs a clone of ${repo} in your workspace (${workdir} or a folder right inside it, origin = the repo): clone it there, or ask the builder to rebase`);
}
