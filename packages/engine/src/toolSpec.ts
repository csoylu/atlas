import { z } from 'zod';
import type { ToolSpec } from './providers/types.ts';

/**
 * The tool specs sent to the model (#295): each tool's zod input as JSON Schema, without what only costs prompt
 * room: `$schema`, and the ±Number.MAX_SAFE_INTEGER bounds zod puts on every integer. Validation stays zod's.
 */
export function specsOf(tools: Record<string, { description: string; input: z.ZodType }>): ToolSpec[] {
  return Object.entries(tools).map(([name, t]) => {
    const { $schema: _s, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<string, unknown>;
    return { name, description: t.description, input_schema: lean(schema) as Record<string, unknown> };
  });
}

function lean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(lean);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if ((k === 'maximum' && x === Number.MAX_SAFE_INTEGER) || (k === 'minimum' && x === Number.MIN_SAFE_INTEGER)) continue;
    // Said by the type itself: an optional flag is off, an optional list empty, a non-empty string obvious.
    if ((k === 'default' && (x === false || x === '' || (Array.isArray(x) && !x.length))) || (k === 'minLength' && x === 1)) continue;
    out[k] = lean(x);
  }
  // anyOf of bare types (a task id: string or integer) = one type list.
  const any = out.anyOf;
  if (Array.isArray(any) && any.every((s) => s && typeof s === 'object' && Object.keys(s).length === 1 && typeof (s as { type?: unknown }).type === 'string')) {
    delete out.anyOf;
    out.type = any.map((s) => (s as { type: string }).type);
  }
  return out;
}
