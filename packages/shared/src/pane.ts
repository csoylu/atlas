import { z } from 'zod';

/**
 * « What the agent sees » (#305): the tab open in the chat's right pane when Master sends a message, sent with it
 * (the eye in the composer). Only where it is, never its content: the agent reads that with its tools.
 */
export const PaneSees = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('artifact'),
    docId: z.string().min(1).max(100),
    title: z.string().max(300),
    /** Whose workspace the file is in, and its path there. */
    agentId: z.string().min(1).max(100),
    path: z.string().min(1).max(1000),
    /** The version on screen. */
    version: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('file'),
    path: z.string().min(1).max(1000),
    /** The lines on screen (1-based, inclusive). */
    from: z.number().int().positive(),
    to: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('task'), number: z.number().int().positive(), title: z.string().max(300) }),
  z.object({ kind: z.literal('browser'), url: z.string().min(1).max(2000), title: z.string().max(300) }),
]);
export type PaneSees = z.infer<typeof PaneSees>;

/** The mark that starts the line (the eye, as in the composer). */
export const PANE_MARK = '👁 ';

const host = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url; // not a full address (« localhost:5173/x »): shown as typed
  }
};
const base = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;
const one = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The one short line the agent gets with the message (#305): kind, title, where it is. The same pane state always
 * gives the same line (the engine compares lines to say it only when it changed).
 */
export function paneLine(p: PaneSees): string {
  const what =
    p.kind === 'artifact'
      ? `artifact « ${one(p.title)} » (${p.docId} v${p.version}, @${p.agentId}:${p.path})`
      : p.kind === 'file'
        ? `file ${p.path}, lines ${p.from}–${Math.max(p.from, p.to)}`
        : p.kind === 'task'
          ? `task #${p.number} « ${one(p.title)} »`
          : `web page « ${one(p.title) || host(p.url)} » at ${p.url}`;
  return `${PANE_MARK}Open in my pane: ${what}`; // isPaneLine below knows this start
}

/** The tab's name, as the composer's eye and the sent message show it (« Tenders · localhost:5173 », « docPanel.ts »). */
export function paneLabel(p: PaneSees): string {
  if (p.kind === 'artifact') return one(p.title) || base(p.path);
  if (p.kind === 'file') return base(p.path);
  if (p.kind === 'task') return `#${p.number} ${one(p.title)}`.trim();
  return one(p.title) ? `${one(p.title)} · ${host(p.url)}` : host(p.url);
}

/** Same pane state (field by field). */
export const samePane = (a: PaneSees | null | undefined, b: PaneSees | null | undefined): boolean =>
  !a || !b ? !a && !b : paneLine(a) === paneLine(b);

/** A text block that is that line (the chat shows « … was open » under the message instead). */
export const isPaneLine = (text: string): boolean => text.startsWith(`${PANE_MARK}Open in my pane: `);
