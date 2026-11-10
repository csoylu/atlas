import { z } from 'zod';
import { CanvasOp, SketchElement, type Canvas, type CanvasNode } from '@atlas/shared';
import type { Canvases } from './canvas.ts';
import type { ToolSpec } from './providers/types.ts';

export interface CanvasToolContext {
  canvases: Canvases;
  agentId: string;
}

const OUTPUT_CAP = 30_000;

/** Node as an agent writes it: position and size are optional (auto-placed to the right of existing nodes). */
const LooseNode = z.object({
  id: z.string().min(1),
  kind: z.enum(['markdown', 'html', 'url', 'drawing']),
  title: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().optional(),
  h: z.number().optional(),
  cardId: z.string().nullable().optional(),
  text: z.string().optional().describe('markdown nodes: the markdown'),
  html: z.string().optional().describe('html nodes: a full HTML document or fragment, rendered in a sandboxed iframe'),
  url: z.string().optional().describe('url nodes: http(s) URL, or /api/files/<agent>/<path> for a file in an agent workspace'),
  sketch: z.array(SketchElement).optional().describe('drawing nodes: simplified elements; arrows bind with from/to ids'),
});

const DEFAULT_SIZE: Record<CanvasNode['kind'], [number, number]> = {
  markdown: [420, 320],
  html: [640, 480],
  url: [960, 640],
  drawing: [720, 480],
};

function place(n: z.infer<typeof LooseNode>, canvas: Canvas, pending: CanvasNode[]): CanvasNode {
  const existing = canvas.nodes.find((x) => x.id === n.id);
  const [dw, dh] = DEFAULT_SIZE[n.kind];
  const all = [...canvas.nodes, ...pending];
  const right = all.length ? Math.max(...all.map((x) => x.x + x.w)) + 60 : 0;
  const base = {
    id: n.id,
    title: n.title ?? existing?.title ?? '',
    x: n.x ?? existing?.x ?? right,
    y: n.y ?? existing?.y ?? 0,
    w: n.w ?? existing?.w ?? dw,
    h: n.h ?? existing?.h ?? dh,
    cardId: n.cardId ?? existing?.cardId ?? null,
  };
  const prev = existing?.kind === n.kind ? existing : undefined;
  switch (n.kind) {
    case 'markdown':
      return { ...base, kind: 'markdown', text: n.text ?? (prev as { text?: string } | undefined)?.text ?? '' };
    case 'html':
      return { ...base, kind: 'html', html: n.html ?? (prev as { html?: string } | undefined)?.html ?? '' };
    case 'url':
      return { ...base, kind: 'url', url: n.url ?? (prev as { url?: string } | undefined)?.url ?? 'about:blank' };
    case 'drawing':
      return { ...base, kind: 'drawing', scene: n.sketch ? { sketch: n.sketch } : ((prev as { scene?: object } | undefined)?.scene ?? { sketch: [] }) };
  }
}

/** What an agent reads: full markdown/html/url, drawings as sketch or a compact summary of Excalidraw elements. */
export function readable(canvas: Canvas): string {
  const nodes = canvas.nodes.map((n) => {
    if (n.kind !== 'drawing' || !n.scene.elements) return n;
    const elements = (n.scene.elements as Record<string, unknown>[])
      .filter((e) => !e.isDeleted)
      .map((e) => ({ id: e.id, type: e.type, x: Math.round(Number(e.x)), y: Math.round(Number(e.y)), w: Math.round(Number(e.width)), h: Math.round(Number(e.height)), text: e.text ?? undefined }));
    return { ...n, scene: { edited_in_ui: true, elements } };
  });
  const out = JSON.stringify({ id: canvas.id, name: canvas.name, version: canvas.version, nodes }, null, 1);
  return out.length > OUTPUT_CAP ? out.slice(0, OUTPUT_CAP) + `\n[truncated, ${out.length - OUTPUT_CAP} chars omitted]` : out;
}

interface CanvasTool<S extends z.ZodType> {
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: CanvasToolContext): string;
}
const tool = <S extends z.ZodType>(t: CanvasTool<S>) => t;

export const CANVAS_TOOLS = {
  canvas_list: tool({
    description: 'List canvases (shared boards Can sees live: diagrams, HTML mockups, running apps, explanations).',
    input: z.object({}),
    run: (_i, { canvases }) =>
      canvases
        .list()
        .map((c) => `${c.id} "${c.name}" v${c.version} (by ${c.updatedBy})`)
        .join('\n') || '(no canvases)',
  }),
  canvas_create: tool({
    description: 'Create an empty canvas and return its id.',
    input: z.object({ name: z.string().min(1).max(100) }),
    run: ({ name }, { canvases, agentId }) => `created ${canvases.create({ name }, agentId).id}`,
  }),
  canvas_read: tool({
    description: 'Read a canvas: every node with its content.',
    input: z.object({ id: z.string() }),
    run: ({ id }, { canvases }) => readable(canvases.get(id)),
  }),
  canvas_write: tool({
    description:
      'Add, replace or delete nodes on a canvas; Can sees changes live. Node kinds: markdown (text), html (a page or ' +
      'component, rendered sandboxed: use it for UI mockups and design showcases), url (a running app or a file served ' +
      'from your workspace as /api/files/<agent>/<path>), drawing (system design diagrams: sketch elements with ' +
      'x/y/width/height/label; arrows use from/to element ids). Omitted position/size: placed automatically. ' +
      'Upsert replaces the node with that id; omitted content fields keep their previous value.',
    input: z.object({
      id: z.string().describe('canvas id'),
      upsert: z.array(LooseNode).default([]),
      delete: z.array(z.string()).default([]),
    }),
    run: (i, { canvases, agentId }) => {
      const canvas = canvases.get(i.id);
      const placed: CanvasNode[] = [];
      for (const n of i.upsert) placed.push(place(n, canvas, placed));
      const ops = [
        ...placed.map((node) => CanvasOp.parse({ op: 'upsert', node })),
        ...i.delete.map((id) => CanvasOp.parse({ op: 'delete', id })),
      ];
      const after = canvases.apply(i.id, ops, agentId);
      return `canvas ${after.id} is now v${after.version} with ${after.nodes.length} nodes`;
    },
  }),
} satisfies Record<string, CanvasTool<z.ZodType>>;

export function canvasToolSpecs(): ToolSpec[] {
  return Object.entries(CANVAS_TOOLS).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: schema };
  });
}

export const isCanvasTool = (name: string) => name in CANVAS_TOOLS;

export function runCanvasTool(name: string, input: unknown, ctx: CanvasToolContext): { output: string; isError: boolean } {
  const t = (CANVAS_TOOLS as Record<string, CanvasTool<z.ZodType>>)[name]!;
  const parsed = t.input.safeParse(input);
  if (!parsed.success) return { output: `invalid input for ${name}: ${parsed.error.message}`, isError: true };
  try {
    return { output: t.run(parsed.data, ctx), isError: false };
  } catch (e) {
    return { output: e instanceof Error ? e.message : String(e), isError: true };
  }
}
