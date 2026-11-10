import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanvasNode, ServerEvent } from '@atlas/shared';
import { openDb } from './store/db.ts';
import { Bus } from './events.ts';
import { Canvases, StaleVersionError } from './canvas.ts';
import { readable, runCanvasTool } from './canvasTools.ts';
import { startEngine, type Engine } from './index.ts';

function setup() {
  const bus = new Bus();
  const events: ServerEvent[] = [];
  bus.on((e) => events.push(e));
  return { canvases: new Canvases(openDb(':memory:'), bus), events };
}
const md = (id: string, text = 'hi'): CanvasNode => ({ id, kind: 'markdown', x: 0, y: 0, w: 300, h: 200, title: '', text });

describe('canvases', () => {
  it('saves with optimistic versions and rejects a stale save', () => {
    const { canvases, events } = setup();
    const c = canvases.create({ name: 'System' }, 'can');
    const v2 = canvases.save(c.id, { nodes: [md('a')], baseVersion: 1 }, 'can');
    expect(v2.version).toBe(2);
    expect(() => canvases.save(c.id, { nodes: [], baseVersion: 1 }, 'can')).toThrow(StaleVersionError);
    expect(events.filter((e) => e.type === 'canvas.updated')).toHaveLength(2);
  });

  it('applies agent ops on the latest version and refuses duplicates', () => {
    const { canvases } = setup();
    const c = canvases.create({ name: 'x' }, 'can');
    canvases.apply(c.id, [{ op: 'upsert', node: md('a') }, { op: 'upsert', node: md('b') }], 'atlas');
    canvases.apply(c.id, [{ op: 'upsert', node: md('a', 'changed') }, { op: 'delete', id: 'b' }], 'atlas');
    const now = canvases.get(c.id);
    expect(now.nodes).toEqual([md('a', 'changed')]);
    expect(now.updatedBy).toBe('atlas');
    expect(() => canvases.apply(c.id, [{ op: 'delete', id: 'zz' }], 'atlas')).toThrow(/not on canvas/);
    expect(() => canvases.save(c.id, { nodes: [md('a'), md('a')], baseVersion: now.version }, 'can')).toThrow(/duplicate/);
    expect(canvases.get(c.id).version).toBe(now.version); // failed writes change nothing
  });

  it('keeps the last 50 versions and restores one', () => {
    const { canvases } = setup();
    const c = canvases.create({ name: 'x' }, 'can');
    for (let i = 0; i < 60; i++) canvases.apply(c.id, [{ op: 'upsert', node: md('a', String(i)) }], 'atlas');
    const versions = canvases.versions(c.id);
    expect(versions).toHaveLength(50);
    expect(versions[0]!.version).toBe(61);
    const restored = canvases.restore(c.id, 20, 'can');
    expect(restored.nodes).toEqual([md('a', '18')]);
    expect(restored.version).toBe(62);
    expect(() => canvases.restore(c.id, 2, 'can')).toThrow(/no version 2/);
  });
});

describe('canvas tools', () => {
  it('auto-places nodes and keeps omitted content', () => {
    const { canvases } = setup();
    const c = canvases.create({ name: 'x' }, 'can');
    const ctx = { canvases, agentId: 'atlas' };
    const r = runCanvasTool(
      'canvas_write',
      {
        id: c.id,
        upsert: [
          { id: 'notes', kind: 'markdown', text: '# Plan' },
          { id: 'arch', kind: 'drawing', sketch: [{ id: 'api', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, label: 'API' }, { id: 'db', type: 'rectangle', x: 300, y: 0, label: 'DB' }, { type: 'arrow', x: 120, y: 30, from: 'api', to: 'db' }] },
        ],
      },
      ctx,
    );
    expect(r).toMatchObject({ isError: false });
    let nodes = canvases.get(c.id).nodes;
    expect(nodes.map((n) => [n.id, n.x, n.w])).toEqual([
      ['notes', 0, 420],
      ['arch', 480, 720],
    ]);
    runCanvasTool('canvas_write', { id: c.id, upsert: [{ id: 'notes', kind: 'markdown', title: 'Plan', y: 50 }] }, ctx);
    nodes = canvases.get(c.id).nodes;
    expect(nodes[0]).toMatchObject({ id: 'notes', title: 'Plan', y: 50, text: '# Plan' });
    expect(runCanvasTool('canvas_write', { id: 'nope', upsert: [] }, ctx)).toMatchObject({ isError: true });
  });

  it('summarises UI-edited drawings for agents', () => {
    const { canvases } = setup();
    const c = canvases.create({ name: 'x' }, 'can');
    canvases.apply(c.id, [{ op: 'upsert', node: { id: 'd', kind: 'drawing', x: 0, y: 0, w: 400, h: 300, title: '', scene: { elements: [{ id: 'e1', type: 'text', x: 1.4, y: 2, width: 50, height: 20, text: 'Hello', strokeColor: '#000', seed: 123 }, { id: 'e2', type: 'rectangle', isDeleted: true }] } } }], 'can');
    const out = JSON.parse(readable(canvases.get(c.id)));
    expect(out.nodes[0].scene).toEqual({ edited_in_ui: true, elements: [{ id: 'e1', type: 'text', x: 1, y: 2, w: 50, h: 20, text: 'Hello' }] });
  });
});

describe('workspace files', () => {
  let engine: Engine | undefined;
  afterEach(async () => {
    await engine?.stop();
  });

  it('serves agent files sandboxed, with index.html for folders, and refuses paths outside', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    mkdirSync(join(dataDir, 'workspaces/atlas/site'), { recursive: true });
    writeFileSync(join(dataDir, 'workspaces/atlas/site/index.html'), '<h1>Hi</h1>');
    engine = await startEngine({ dbFile: ':memory:', dataDir, port: 0, dispatch: false });
    const ok = await fetch(engine.url + '/api/files/atlas/site/');
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('<h1>Hi</h1>');
    expect(ok.headers.get('content-security-policy')).toMatch(/^sandbox /);
    expect((await fetch(engine.url + '/api/files/atlas/missing.html')).status).toBe(404);
    expect((await fetch(engine.url + '/api/files/atlas/%2e%2e/%2e%2e/etc/passwd')).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(engine.url + '/api/files/nobody/x')).status).toBe(404);
  });
});
