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

/** A member's workspace: `ready` = usable; cloning comes with #214. */
export const CloneState = z.enum(['pending', 'cloning', 'ready', 'failed']);
export type CloneState = z.infer<typeof CloneState>;

export interface ProjectMember {
  agentId: string;
  /** Absolute path of its workspace for this project; null = the agent's own workspace (the first project). */
  workspace: string | null;
  cloneState: CloneState;
  cloneError: string | null;
  joinedAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** GitHub owner/name, fixed once set; null = no repo. */
  repo: string | null;
  /** Gets the project's new tasks (triage); always a member. null = nobody triages. */
  lead: string | null;
  /** Hue 0-359 of its mark. */
  colour: number;
  status: 'active' | 'archived';
  createdAt: string;
  archivedAt: string | null;
  members: ProjectMember[];
  /** The default project: what a task, chat or artifact gets when no project is given (the oldest active one). */
  isDefault: boolean;
}

export const CreateProject = z.object({
  name: z.string().trim().min(1).max(60),
  repo: RepoName.nullable().default(null),
  lead: z.string().min(1).nullable().default(null),
  /** Agents; the lead is added if missing. */
  members: z.array(z.string().min(1)).default([]),
  /** omitted = the first unused hue of PROJECT_HUES. */
  colour: z.number().int().min(0).max(359).optional(),
});
export type CreateProject = z.input<typeof CreateProject>;

/** PATCH /api/projects/:id. The repo is fixed once set: giving another one is refused. */
export const UpdateProject = z
  .object({
    name: z.string().trim().min(1).max(60),
    repo: RepoName.nullable(),
    lead: z.string().min(1).nullable(),
    /** The whole member list (the lead is added if missing). */
    members: z.array(z.string().min(1)),
    colour: z.number().int().min(0).max(359),
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
