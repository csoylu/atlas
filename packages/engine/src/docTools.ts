import { z } from 'zod';
import { findSection, splitSections, type Doc, type DocKind } from '@atlas/shared';
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
  /**
   * The project a call acts on (#213): `asked` omitted = the run's project; another one only for a lead (throws
   * otherwise). Omitted (tests): the default project, no checks.
   */
  scope?: (asked?: string) => string | undefined;
}

/** Refuse an artifact of another project unless the agent may cross (a lead). */
function reachDoc(doc: Doc, ctx: DocToolContext): Doc {
  if (ctx.scope && doc.projectId !== ctx.scope()) ctx.scope(doc.projectId);
  return doc;
}

const Target = {
  artifact: z.string().optional().describe('an artifact id (doc_…) or a path in your workspace (e.g. docs/design.md)'),
  path: z.string().optional().describe('same as artifact: a path in your workspace'),
};

function resolveDoc(i: { artifact?: string; path?: string }, ctx: DocToolContext): Doc {
  const ref = i.artifact ?? i.path;
  if (!ref) throw new Error('give the artifact (id or path)');
  return reachDoc(ctx.documents.resolve(ctx.agentId, ref, ctx.cardId), ctx);
}

/** « Title (doc_x, path, vN) »: the line the chat card is read from (ui cardModal.ts artifactOf). */
const label = (doc: Doc) => `${doc.title} (${doc.id}, ${doc.path}, v${doc.version})`;

/** Show an artifact in the chat's side panel (a created or updated one appears right away). */
function show(doc: Doc, section: string | null, ctx: DocToolContext): string {
  const attached = doc.cardId ? `; attached to task ${ctx.cardRef?.(doc.cardId) ?? doc.cardId}` : '';
  if (!ctx.chatId) return `${attached ? attached.slice(2) : 'not attached to a task'}. This task has no chat with the user, so it isn't shown in a panel: the user opens it from the task or the Library.`;
  ctx.documents.open(ctx.chatId, doc.id, ctx.agentId, section);
  return `shown in the side panel of chat ${ctx.chatId}${section ? `, scrolled to #${section}` : ''}${attached}`;
}

const KIND = z.enum(['markdown', 'html', 'svg', 'url']);
const kindOf = (k: z.infer<typeof KIND>): DocKind => (k === 'svg' ? 'diagram' : k);
const folderOf = (doc: Doc, ctx: DocToolContext) => (doc.folderId ? ctx.documents.folder(doc.folderId).name : 'Unfiled');

/** A markdown heading (id or text) or an html element id; diagrams and links have no sections. */
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
  artifact_create: tool({
    description:
      'Create an artifact: a markdown document (specs, designs, reports), an html page (mockups, UI), an svg diagram ' +
      '(system design) or a url link (a running app, a page served from your workspace at /api/files/<you>/<path>). ' +
      'It is saved as a file in your workspace (docs/, pages/, diagrams/, links/), versioned, listed in the Library, and ' +
      'appears in the chat right away (in a task: attached to it). Use it instead of pasting long text. folder: a ' +
      'Library folder name (created if new); leave it out for Unfiled.',
    input: z.object({
      kind: KIND,
      title: z.string().min(1).max(200),
      content: z.string().describe('the markdown, html or svg; for url: the address'),
      folder: z.string().optional(),
      path: z.string().optional().describe('optional file path in your workspace; default from the title'),
    }),
    run: (i, ctx) => {
      const doc = ctx.documents.create(ctx.agentId, { kind: kindOf(i.kind), title: i.title, content: i.content, path: i.path, folder: i.folder ?? null }, ctx.agentId, ctx.cardId);
      return `created ${label(doc)} in ${folderOf(doc, ctx)}; ${show(doc, null, ctx)}`;
    },
  }),
  artifact_update: tool({
    description:
      'Change an artifact: a new version that appears in the chat right away (older chat cards keep their version). ' +
      'Give the whole new content, or old_text + new_text for one exact replacement; title renames it. Editing the ' +
      'file with write_file / edit_file also makes a version, but posts no card.',
    input: z.object({
      ...Target,
      content: z.string().optional(),
      old_text: z.string().optional(),
      new_text: z.string().optional(),
      title: z.string().optional(),
      section: z.string().optional().describe('scroll the panel to this markdown heading or html id'),
    }),
    run: (i, ctx) => {
      const before = resolveDoc(i, ctx);
      const doc = ctx.documents.update(before.id, { content: i.content, oldText: i.old_text, newText: i.new_text, title: i.title }, ctx.agentId, ctx.cardId);
      const same = doc.version === before.version;
      return `${same ? 'unchanged' : 'updated'} ${label(doc)}${same ? ' (same content)' : ''}; ${show(doc, sectionOf(doc, i.section, ctx), ctx)}`;
    },
  }),
  artifact_list: tool({
    description: "List this project's artifacts in the Library (every agent's), latest first: id, kind, title, version, folder, path. query searches titles and content.",
    input: z.object({
      query: z.string().optional(),
      folder: z.string().optional().describe('a folder name, or Unfiled'),
      project: z.string().min(1).optional().describe("project id or name; omitted = this run's project (another project: leads only)"),
    }),
    run: (i, ctx) => {
      const project = ctx.scope?.(i.project);
      let docs = i.query?.trim() ? ctx.documents.search(i.query, 50, project).map((h) => h.doc) : ctx.documents.library({ project });
      if (i.folder) {
        const unfiled = i.folder.trim().toLowerCase() === 'unfiled';
        const f = unfiled ? null : ctx.documents.folderNamed(i.folder, project);
        if (!unfiled && !f) throw new Error(`no folder "${i.folder}"; folders: ${ctx.documents.folders(project).map((x) => x.name).join(', ') || 'none'}`);
        docs = docs.filter((d) => d.folderId === (f?.id ?? null));
      }
      if (!docs.length) return 'no artifacts';
      return docs
        .slice(0, 100)
        .map((d) => `${d.id} · ${d.kind} · ${d.title} · v${d.version} · ${folderOf(d, ctx)}${d.pinned ? ' · pinned' : ''} · @${d.agentId}:${d.path}`)
        .join('\n');
    },
  }),
  artifact_read: tool({
    description: 'Read an artifact\'s content (any agent\'s), at its latest version or an older one.',
    input: z.object({ ...Target, version: z.number().int().positive().optional() }),
    run: (i, ctx) => {
      const ref = i.artifact ?? i.path;
      const doc = ref && /^doc_[\w-]+$/.test(ref) ? reachDoc(ctx.documents.get(ref), ctx) : resolveDoc(i, ctx);
      const c = ctx.documents.content(doc.id, i.version);
      const text = c.content.length > 60_000 ? c.content.slice(0, 60_000) + `\n… (${c.content.length - 60_000} more characters: read the file)` : c.content;
      return `${doc.title} (${doc.id}, ${doc.kind}, v${c.version} of ${doc.version}, ${folderOf(doc, ctx)}, @${doc.agentId}:${doc.path})\n\n${text}`;
    },
  }),
  artifact_delete: tool({
    description:
      'Delete one of your own artifacts for good (file and every version). Cannot be undone: only when the user asks.',
    input: z.object(Target),
    run: (i, ctx) => {
      const ref = i.artifact ?? i.path;
      if (!ref) throw new Error('give the artifact (id or path)');
      const doc = /^doc_[\w-]+$/.test(ref) ? ctx.documents.get(ref) : ctx.documents.byPath(ctx.agentId, ref, ctx.cardId);
      if (!doc) throw new Error(`no artifact ${ref} in your workspace`);
      reachDoc(doc, ctx);
      if (doc.agentId !== ctx.agentId) throw new Error(`${doc.title} (${doc.id}) is @${doc.agentId}'s artifact: you can delete only your own`);
      const r = ctx.documents.remove(doc.id);
      return `deleted ${doc.title} (${doc.id}, ${doc.path}): ${r.versions} version${r.versions === 1 ? '' : 's'}${r.file ? ' and the file' : ''} removed`;
    },
  }),
  panel_open: tool({
    description:
      'Show an existing artifact again in the side panel beside the chat (artifact_create / artifact_update already ' +
      'show theirs). section scrolls to a markdown heading (id or text) or an html element id.',
    input: z.object({ ...Target, section: z.string().optional() }),
    run: (i, ctx) => {
      const doc = resolveDoc(i, ctx);
      const section = sectionOf(doc, i.section, ctx);
      return `opened ${label(doc)}; ${show(doc, section, ctx)}`;
    },
  }),
  panel_close: tool({
    description: 'Close an artifact\'s tab in the side panel beside the chat, or the whole panel (no artifact).',
    input: z.object(Target),
    run: (i, ctx) => {
      if (!ctx.chatId) throw new Error('this task has no chat with the user, so there is no panel to close');
      const ref = i.artifact ?? i.path;
      if (!ref) {
        ctx.documents.close(ctx.chatId, null);
        return 'closed the panel';
      }
      const doc = /^doc_[\w-]+$/.test(ref) ? ctx.documents.get(ref) : ctx.documents.byPath(ctx.agentId, ref, ctx.cardId);
      if (!doc) throw new Error(`${ref} is not open`);
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
