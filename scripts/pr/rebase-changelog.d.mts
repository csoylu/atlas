// Types of rebase-changelog.mjs for the engine's pr_validate tool (#216).
import type { RebaseResult } from './validate.mjs';

export const FILE: string;
export function rebaseChangelogOnly(o: { repo: string; branch: string; sha: string; base?: string; remote?: string; env?: NodeJS.ProcessEnv }): Promise<RebaseResult>;
