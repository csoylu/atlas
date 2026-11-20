import { z } from 'zod';

/**
 * Projects (#213, design §17): a repo the team works on, with its own tasks, chats, artifacts, workflows and memory.
 * Agents are global; each one is a member of some projects. The lead gets the project's new tasks (triage).
 */

/** The hues Atlas picks a new project's colour from (the first unused one), in order. Editable afterwards. */
export const PROJECT_HUES = [212, 145, 25, 280, 335, 50, 180, 0] as const;

/** GitHub `owner/name`. */
export const RepoName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/, 'a GitHub repo is owner/name');

/**
 * A member's workspace (#214): `pending` = queued, `cloning` = git is fetching it (or making the empty folder of a
 * project without a repo), `ready` = usable, `failed` = the clone failed (cloneError says why; retry).
 */
export const CloneState = z.enum(['pending', 'cloning', 'ready', 'failed']);
export type CloneState = z.infer<typeof CloneState>;

/**
 * Internet access of a workspace (#298 §2): `on` = everything, `hosts` = only the allowed hosts (through the engine's
 * proxy), `off` = nothing but the workspace's own localhost. Applies to agent commands in the sandbox and to web_fetch;
 * `web_search` is not offered when off. Model calls, PR polling, clones and updates are the engine's: never limited.
 */
export const NetworkLevel = z.enum(['on', 'hosts', 'off']);
export type NetworkLevel = z.infer<typeof NetworkLevel>;

/** An allowed host: `github.com`, or `*.npmjs.org` (the domain and every subdomain). Lower case, no scheme, port or path. */
export const HostRule = z
  .string()
  .trim()
  .toLowerCase()
  .transform((s) => s.replace(/\.$/, ''))
  .refine((s) => /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(s) && s.length <= 253, {
    message: 'an allowed host is a name like github.com or *.npmjs.org (no scheme, port or path)',
  });
export const HostRules = z.array(HostRule).max(500).transform((l) => [...new Set(l)]);

/** PATCH /api/projects/:id/members/:agent: the workspace's own internet setting. null = the project's. */
export const UpdateMember = z
  .object({
    network: NetworkLevel.nullable(),
    /** Replaces the project's list for this workspace (no merge); null or [] = the project's list. */
    allowedHosts: HostRules.nullable(),
  })
  .partial();
export type UpdateMember = z.input<typeof UpdateMember>;

/** GET /api/projects/:id/refusals: hosts the allow-list refused, per workspace (what « Allow » offers). Newest first. */
export interface NetworkRefusal {
  agentId: string;
  host: string;
  count: number;
  lastAt: string;
}

export interface ProjectMember {
  agentId: string;
  /** Its own internet level (#298 §2); null = the project's. */
  network: NetworkLevel | null;
  /** Its own allowed hosts, replacing the project's; null = the project's list. */
  allowedHosts: string[] | null;
  /** Absolute path of its workspace for this project; null = the agent's own workspace (the first project). */
  workspace: string | null;
  cloneState: CloneState;
  cloneError: string | null;
  /** Works in the agent's own workdir (the first project, as before projects): nothing is cloned. */
  home: boolean;
  /** While cloning: git's progress 0-100 (receiving objects), null before git says it. Not stored. */
  cloneProgress: number | null;
  /** Its main chat in this project (#214): created on first use; null = none yet. */
  mainChat: string | null;
  joinedAt: string;
  /** The branch checked out in its workspace (#217), read from .git/HEAD; null when unknown (no clone yet, detached). */
  branch: string | null;
}

/** A removed member's workspace (#214): kept on disk until Master deletes it. */
export interface KeptWorkspace {
  agentId: string;
  path: string;
  /** The agent's own workdir (the first project's workspace): never deleted from Atlas. */
  home: boolean;
  keptAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** GitHub owner/name, fixed once set; null = no repo. */
  repo: string | null;
  /**
   * PR validation gate (#216): the CI check that must be green on a PR's head before QA validates it; null = every
   * check run on the head green. Atlas: « test ». A repo's own rules (Atlas's changelog entry) run in its CI (#238).
   */
  ciJob: string | null;
  /** Internet level of its workspaces (#298 §2), default `on`; a member can override it. */
  network: NetworkLevel;
  /** Allowed hosts when the level is `hosts` (a member's own list replaces it). */
  allowedHosts: string[];
  /** Gets the project's new tasks (triage); always a member. null = nobody triages. */
  lead: string | null;
  /**
   * Reviews the project's pull requests (#263): the agent of its Review workflow's « Review the PR » step; the lead
   * reviews this agent's own PRs. A member; null = nobody: the step can't run and says so.
   */
  reviewAgent: string | null;
  /** Hue 0-359 of its mark. */
  colour: number;
  status: 'active' | 'archived';
  createdAt: string;
  archivedAt: string | null;
  members: ProjectMember[];
  /** Workspaces of removed members, still on disk. */
  kept: KeptWorkspace[];
  /** The default project: what a task, chat or artifact gets when no project is given (the oldest active one). */
  isDefault: boolean;
}

/** A CI check name; empty = any (every check green). */
const CiJob = z
  .string()
  .trim()
  .max(100)
  .transform((s) => s || null)
  .nullable();

export const CreateProject = z.object({
  name: z.string().trim().min(1).max(60),
  repo: RepoName.nullable().default(null),
  ciJob: CiJob.default(null),
  lead: z.string().min(1).nullable().default(null),
  reviewAgent: z.string().min(1).nullable().default(null),
  /** Agents; the lead is added if missing. */
  members: z.array(z.string().min(1)).default([]),
  /** omitted = the first unused hue of PROJECT_HUES. */
  colour: z.number().int().min(0).max(359).optional(),
});
export type CreateProject = z.input<typeof CreateProject>;

/** PATCH /api/projects/:id. The repo is fixed once a member's clone is ready: giving another one is refused. */
export const UpdateProject = z
  .object({
    name: z.string().trim().min(1).max(60),
    repo: RepoName.nullable(),
    ciJob: CiJob,
    lead: z.string().min(1).nullable(),
    reviewAgent: z.string().min(1).nullable(),
    /** The whole member list (the lead is added if missing). */
    members: z.array(z.string().min(1)),
    colour: z.number().int().min(0).max(359),
    /** Internet level of its workspaces (#298 §2); applies from each workspace's next command. */
    network: NetworkLevel,
    allowedHosts: HostRules,
  })
  .partial();
export type UpdateProject = z.input<typeof UpdateProject>;

/** GET /api/projects/repo-check?repo=owner/name: what the New project form shows under the repo field. */
export interface RepoCheck {
  repo: string;
  /** Readable with Master's GitHub login (gh). */
  found: boolean;
  private: boolean | null;
  defaultBranch: string | null;
  /** Instruction files at the root of the default branch (CLAUDE.md, AGENTS.md). */
  instructions: string[];
  /** Why it was not found (gh's message), when found is false. */
  error: string | null;
}
