// Types of migrations.mjs (#236) for the engine's merge queue (prSync.ts) and validate.mjs.
export interface Migration { path: string; dir: string; number: number; stem: string }
export interface Clash { path: string; number: number; max: number }
export interface Rename { from: string; to: string; fromStem: string; toStem: string }
export function parseMigration(path: string): Migration | null;
export function clashes(added: string[], main: string[]): Clash[];
export function renumber(added: string[], main: string[]): Rename[];
export function describe(c: Clash): string;
