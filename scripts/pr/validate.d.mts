// Types of validate.mjs for the engine's pr_validate tool (#216). The script stays plain JS (Master runs it with node).
export type Gh = (args: string[]) => string | Promise<string>;

export interface ValidateOptions {
  pr: number;
  verdict: 'success' | 'failure';
  /** The head commit that was reviewed (--ok). */
  sha: string | null;
  /** Who validates: written in the status description. */
  as: string;
  reason: string;
  merge: boolean;
  /** The branch the PR must be based on; null = the repo's default branch (only the CLI's --base sets it). */
  base: string | null;
  /** The project's gate (#216): its GitHub repo, owner/name. A repo's own rules are its CI checks (#238). */
  repo: string;
  /** The required CI check; null or '' = every check run on the head green. */
  ciJob: string | null;
}

export const REPO: string;
export const CONTEXT: string;
export const CI_JOB: string;
export function gateOf(o: Partial<ValidateOptions>): { repo: string; ciJob: string | null };
export function ghBinary(): string;
export function ghClient(o?: { bin?: string; env?: NodeJS.ProcessEnv }): (args: string[]) => Promise<string>;
export function validate(o: ValidateOptions, gh?: Gh): Promise<string[]>;
