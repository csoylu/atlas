import { randomUUID } from 'node:crypto';
import { CanvasNode, CanvasOp, CreateCanvas, SaveCanvas, type Canvas } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError, NotFoundError } from './kanban.ts';

const KEEP_VERSIONS = 50;

interface Row {
  id: string;
  name: string;
  nodes: string;
  version: number;
  updated_by: string;
  updated_at: string;
}
const toCanvas = (r: Row): Canvas => ({
  id: r.id,
  name: r.name,
  nodes: JSON.parse(r.nodes) as Canvas['nodes'],
  version: r.version,
  updatedBy: r.updated_by,
  updatedAt: r.updated_at,
});

/** The version a save was based on is stale: someone (an agent, another window) saved in between. */
export class StaleVersionError extends ConflictError {
  constructor(readonly current: Canvas) {
    super(`canvas ${current.id} changed (now version ${current.version}); reload and reapply`);
  }
}

/** Canvases: versioned node documents, edited by Can in the UI and by agents through canvas tools (design §11). */
export class Canvases {
  constructor(
    private db: Db,
    private bus: Bus,
  ) {}

  list(): Omit<Canvas, 'nodes'>[] {
    return (
      this.db.prepare('SELECT id, name, version, updated_by, updated_at FROM canvases ORDER BY updated_at DESC').all() as Omit<Row, 'nodes'>[]
    ).map((r) => ({ id: r.id, name: r.name, version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  get(id: string): Canvas {
    const row = this.db.prepare('SELECT * FROM canvases WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`canvas ${id} not found`);
    return toCanvas(row);
  }

  create(input: unknown, by: string): Canvas {
    const { name } = CreateCanvas.parse(input);
    const id = 'cv_' + randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO canvases (id, name, nodes, version, updated_by, updated_at) VALUES (?, ?, ?, 1, ?, ?)').run(id, name, '[]', by, now);
      this.db.prepare('INSERT INTO canvas_versions VALUES (?, 1, ?, ?, ?)').run(id, '[]', by, now);
    })();
    return this.emit(id);
  }

  /** Replace the node list (UI saves). Fails with StaleVersionError if the canvas moved on since baseVersion. */
  save(id: string, input: unknown, by: string): Canvas {
    const s = SaveCanvas.parse(input);
    this.db
      .transaction(() => {
        const cur = this.get(id);
        if (cur.version !== s.baseVersion) throw new StaleVersionError(cur);
        this.write(cur, s.nodes, by, s.name);
      })
      .immediate();
    return this.emit(id);
  }

  /** Apply node operations on the latest version (agents): no conflicts, ops are merged into whatever is there. */
  apply(id: string, ops: unknown, by: string): Canvas {
    const parsed = CanvasOp.array().parse(ops);
    this.db
      .transaction(() => {
        const cur = this.get(id);
        const nodes = [...cur.nodes];
        for (const op of parsed) {
          const i = nodes.findIndex((n) => n.id === (op.op === 'upsert' ? op.node.id : op.id));
          if (op.op === 'delete') {
            if (i < 0) throw new NotFoundError(`node ${op.id} is not on canvas ${id}`);
            nodes.splice(i, 1);
          } else if (i < 0) nodes.push(op.node);
          else nodes[i] = op.node;
        }
        this.write(cur, nodes, by);
      })
      .immediate();
    return this.emit(id);
  }

  rename(id: string, name: string, by: string): Canvas {
    const cur = this.get(id);
    this.db.transaction(() => this.write(cur, cur.nodes, by, CreateCanvas.parse({ name }).name))();
    return this.emit(id);
  }

  /** Go back to an earlier version (as a new version, so the undo itself can be undone). */
  restore(id: string, version: number, by: string): Canvas {
    const row = this.db.prepare('SELECT nodes FROM canvas_versions WHERE canvas_id = ? AND version = ?').get(id, version) as
      | { nodes: string }
      | undefined;
    if (!row) throw new NotFoundError(`canvas ${id} has no version ${version} (the last ${KEEP_VERSIONS} are kept)`);
    const cur = this.get(id);
    this.db.transaction(() => this.write(cur, CanvasNode.array().parse(JSON.parse(row.nodes)), by))();
    return this.emit(id);
  }

  versions(id: string): { version: number; updatedBy: string; updatedAt: string }[] {
    this.get(id);
    return (
      this.db
        .prepare('SELECT version, updated_by, updated_at FROM canvas_versions WHERE canvas_id = ? ORDER BY version DESC')
        .all(id) as { version: number; updated_by: string; updated_at: string }[]
    ).map((r) => ({ version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at }));
  }

  remove(id: string): void {
    this.get(id);
    this.db.prepare('DELETE FROM canvases WHERE id = ?').run(id);
    this.bus.emit({ type: 'canvas.deleted', id });
  }

  private write(cur: Canvas, nodes: Canvas['nodes'], by: string, name = cur.name): void {
    const ids = new Set<string>();
    for (const n of nodes) {
      if (ids.has(n.id)) throw new ConflictError(`duplicate node id ${n.id}`);
      ids.add(n.id);
    }
    const version = cur.version + 1;
    const now = new Date().toISOString();
    const json = JSON.stringify(nodes);
    this.db
      .prepare('UPDATE canvases SET name = ?, nodes = ?, version = ?, updated_by = ?, updated_at = ? WHERE id = ?')
      .run(name, json, version, by, now, cur.id);
    this.db.prepare('INSERT INTO canvas_versions VALUES (?, ?, ?, ?, ?)').run(cur.id, version, json, by, now);
    this.db.prepare('DELETE FROM canvas_versions WHERE canvas_id = ? AND version <= ?').run(cur.id, version - KEEP_VERSIONS);
  }

  private emit(id: string): Canvas {
    const canvas = this.get(id);
    this.bus.emit({ type: 'canvas.updated', canvas });
    return canvas;
  }
}
