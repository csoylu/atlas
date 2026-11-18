import type { ContentBlock } from '@atlas/shared';
import type { TestAtlas } from './engine.ts';

/** A scripted model reply that calls one tool. */
export const tu = (name: string, input: unknown, id = 'tu_' + Math.random().toString(36).slice(2, 8)): ContentBlock[] => [{ type: 'tool_use', id, name, input }];
export const say = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

export interface Res<T = any> {
  status: number;
  body: T;
}
/** Raw API call against a test engine: never throws on a 4xx so tests can assert on the refusal. */
export async function call<T = any>(a: TestAtlas, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const r = await fetch(a.url + '/api' + path, { method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let b: any = t;
  try {
    b = t ? JSON.parse(t) : null;
  } catch {
    /* not json */
  }
  return { status: r.status, body: b };
}

/** A card that nothing will run (m82: status todo, no assignee). */
export async function idleCard(a: TestAtlas, title = 'audit card', extra: Record<string, unknown> = {}) {
  const r = await call(a, 'POST', '/cards', { title, status: 'todo', ...extra });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
}
