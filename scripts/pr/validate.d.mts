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
  base: string;
  /** The project's gate (#216); omitted = Atlas's: csoylu/atlas, CI job "test", changelog entry required. */
  repo?: string;
  /** null or '' = every check run on the head green. */
  ciJob?: string | null;
  changelog?: boolean;
}

export const REPO: string;
export const CONTEXT: string;
export const CI_JOB: string;
export function gateOf(o: Partial<ValidateOptions>): { repo: string; ciJob: string | null; changelog: boolean };
export function ghBinary(): string;
export function ghClient(o?: { bin?: string; env?: NodeJS.ProcessEnv }): (args: string[]) => Promise<string>;
export function validate(o: ValidateOptions, gh?: Gh): Promise<string[]>;
