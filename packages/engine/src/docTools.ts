import { z } from 'zod';
import { findSection, splitSections, type Doc } from '@atlas/shared';
import type { Documents } from './documents.ts';
import type { ToolSpec } from './providers/types.ts';

export interface DocToolContext {
  documents: Documents;
  agentId: string;
  /** The chat whose side panel the agent controls: the direct chat itself, or the chat a card was created from. */
  chatId: string | null;
  /** Work card of the run: documents opened or written in it are attached to it. */
  cardId: string | null;
  /** How a card is named in text (#12). */
  cardRef?: (id: string) => string;
}

const Target = {
  path: z.string().optional().describe('a .md, .html or .svg file in your workspace (e.g. docs/design.md)'),
  canvas: z.string().optional().describe('a canvas id, shown as a whiteboard'),
};

function resolveDoc(i: { path?: string; canvas?: string }, ctx: DocToolContext): Doc {
  if (!!i.path === !!i.canvas) throw new Error('give exactly one of path or canvas');
  return i.path ? ctx.documents.indexFile(ctx.agentId, i.path, ctx.agentId, ctx.cardId) : ctx.documents.whiteboard(i.canvas!, ctx.agentId, ctx.cardId);
}

/** A markdown heading (id or text) or an html element id; diagrams and whiteboards have no sections. */
function sectionOf(doc: Doc, section: string | undefined, ctx: DocToolContext): string | null {
  if (!section) return null;
  if (doc.kind === 'html') return section.replace(/^#/, '');
  if (doc.kind !== 'markdown') throw new Error(`${doc.kind} documents have no sections; open it without section`);
  const sections = splitSections(ctx.documents.content(doc.id).content).filter((s) => s.title);
  const s = findSection(sections, section);
  if (!s) throw new Error(`no section "${section}" in ${doc.path}; its sections: ${sections.map((x) => `#${x.id} (${x.title})`).join(', ') || 'none'}`);
  return s.id;
}

interface DocTool<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: DocToolContext): string;
}
const tool = <S extends z.ZodType>(t: DocTool<S>) => t;

export const DOC_TOOLS = {
  panel_open: tool({
    description:
      'Show a document to the user in the side panel beside the chat, at real size, in a tab: a markdown doc, an html ' +
      'page, an svg diagram (files in your workspace, versioned by Atlas) or a canvas as a whiteboard. Use it for designs, ' +
      'specs and reports instead of pasting long text. section scrolls to a markdown heading (id or text) or an html element ' +
      'id; call again with another section to scroll there. In a task, the document is attached to the task.',
    input: z.object({ ...Target, section: z.string().optional() }),
    run: (i, ctx) => {
      const doc = resolveDoc(i, ctx);
      const section = sectionOf(doc, i.section, ctx);
      const what = `${doc.title} (${doc.id}, ${doc.path ?? 'canvas ' + doc.canvasId}, v${doc.version})`;
      const attached = doc.cardId ? `; attached to task ${ctx.cardRef?.(doc.cardId) ?? doc.cardId}` : '';
      if (!ctx.chatId) return `${what} is indexed${attached}. This task has no chat with the user, so it isn't shown: the user opens it from the task.`;
      ctx.documents.open(ctx.chatId, doc.id, ctx.agentId, section);
      return `opened ${what} in the side panel of chat ${ctx.chatId}${section ? `, scrolled to #${section}` : ''}${attached}`;
    },
  }),
  panel_close: tool({
    description: 'Close a document tab in the side panel beside the chat, or the whole panel (no path or canvas).',
    input: z.object(Target),
    run: (i, ctx) => {
      if (!ctx.chatId) throw new Error('this task has no chat with the user, so there is no panel to close');
      if (!i.path && !i.canvas) {
        ctx.documents.close(ctx.chatId, null);
        return 'closed the panel';
      }
      const doc = i.path ? ctx.documents.byPath(ctx.agentId, i.path) : ctx.documents.list().find((d) => d.canvasId === i.canvas);
      if (!doc) throw new Error(`${i.path ?? i.canvas} is not open`);
      const left = ctx.documents.close(ctx.chatId, doc.id);
      return `closed ${doc.title}; ${left.length} tab${left.length === 1 ? '' : 's'} left`;
    },
  }),
} satisfies Record<string, DocTool<z.ZodType>>;

export function docToolSpecs(): ToolSpec[] {
  return Object.entries(DOC_TOOLS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export const isDocTool = (name: string) => name in DOC_TOOLS;

export function runDocTool(name: string, input: unknown, ctx: DocToolContext): { output: string; isError: boolean } {
  const t = (DOC_TOOLS as Record<string, DocTool<z.ZodType>>)[name]!;
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { output: t.run(parsed.data, ctx), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
