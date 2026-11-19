// Types of migrations.mjs (#236) for its tests.
export interface Migration { path: string; dir: string; number: number; stem: string }
export interface Clash { path: string; number: number; max: number }
export function parseMigration(path: string): Migration | null;
export function clashes(added: string[], main: string[]): Clash[];
export function describe(c: Clash): string;
