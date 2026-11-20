export function findBrowser(o?: { env?: NodeJS.ProcessEnv; install?: boolean }): string | null;
export function browserArgs(binary: string, o: { port: number; profile: string }): string[];
export function startThrowawayEngine(o?: { ui?: string }): Promise<{ base: string; stop: () => void }>;
