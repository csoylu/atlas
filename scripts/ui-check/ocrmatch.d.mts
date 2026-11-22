export const MIN_CONF: number;
export const norm: (s: string) => string;
export function fuzzy(p: string, t: string): number;
export type Key = { text: string; shown: number; x: number; y: number; w: number; h: number };
export type Line = { text: string; conf: number; x: number; y: number; w: number; h: number };
export type Box = { l: number; t: number; r: number; b: number };
export const boxOf: (k: Key, scale: number) => Box;
export const inBox: (o: Line, box: Box) => boolean;
export function labelRead(k: Key, lines: Line[], scale: number): { skip: boolean; read: string; conf: number; ok: boolean };
