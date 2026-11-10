import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Canvas, CanvasNode, CanvasNodeKind, DrawingScene } from '@atlas/shared';
import { api, ApiError } from '../api.ts';
import type { MessageStream } from '../useMessages.ts';
import { KINDS, RENDERERS } from './renderers/index.ts';
import type { Renderer } from './renderers/types.ts';

const DrawingEditor = lazy(() => import('./excalidraw.tsx').then((m) => ({ default: m.DrawingEditor })));

type Meta = Omit<Canvas, 'nodes'>;
interface View {
  x: number;
  y: number;
  z: number;
}

const rendererOf = (kind: CanvasNodeKind) => RENDERERS[kind] as unknown as Renderer;
const newId = () => 'n_' + Math.random().toString(36).slice(2, 9);

export function CanvasView(props: {
  canvasId: string | null;
  stream: MessageStream;
  onSelect(id: string | null): void;
  onOpenCard(id: string): void;
  onError(e: unknown): void;
}) {
  const { stream, onError, onSelect } = props;
  const [list, setList] = useState<Meta[] | null>(null);
  const reload = useCallback(() => api.canvases().then(setList, onError), [onError]);

  useEffect(() => {
    void reload();
    return stream.listen('canvases', () => void reload());
  }, [reload, stream]);

  // Open the most recent canvas when none is selected.
  useEffect(() => {
    if (!props.canvasId && list?.length) onSelect(list[0]!.id);
  }, [props.canvasId, list, onSelect]);

  const create = async () => {
    const name = prompt('Canvas name', 'System design');
    if (!name?.trim()) return;
    const c = await api.createCanvas(name.trim()).catch(onError);
    if (c) onSelect(c.id);
  };

  return (
    <div className="canvas-view">
      <aside className="canvas-list">
        <div className="canvas-list-head">
          Canvases
          <button className="ghost" onClick={create} title="New canvas">
            +
          </button>
        </div>
        {list?.map((c) => (
          <button key={c.id} className={'canvas-item' + (c.id === props.canvasId ? ' active' : '')} onClick={() => onSelect(c.id)}>
            <span className="name">{c.name}</span>
            <span className="meta">
              v{c.version} · {c.updatedBy}
            </span>
          </button>
        ))}
        {list && list.length === 0 && <p className="hint">No canvas yet.</p>}
      </aside>
      {props.canvasId ? (
        <CanvasBoard key={props.canvasId} id={props.canvasId} stream={stream} onOpenCard={props.onOpenCard} onError={onError} onDeleted={() => onSelect(null)} />
      ) : (
        <div className="canvas-empty">
          <h2>One surface for diagrams, mockups and live apps</h2>
          <p>Draw system designs, render HTML components, embed a running app, write explanations. Agents write here too.</p>
          <button className="primary" onClick={create}>
            Create a canvas
          </button>
        </div>
      )}
    </div>
  );
}

function CanvasBoard(props: { id: string; stream: MessageStream; onOpenCard(id: string): void; onError(e: unknown): void; onDeleted(): void }) {
  const { id, stream, onError } = props;
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [nodes, setNodes] = useState<CanvasNode[]>([]);
  const [view, setView] = useState<View>(() => JSON.parse(localStorage.getItem('atlas.view.' + id) ?? 'null') ?? { x: 40, y: 40, z: 0.8 });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [drawingOpen, setDrawingOpen] = useState<string | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const board = useRef<HTMLDivElement>(null);

  // Local edits not yet saved: ids changed or deleted since the last saved version (for merging on conflict).
  const dirty = useRef({ changed: new Set<string>(), deleted: new Set<string>() });
  const base = useRef(0);
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  const adopt = useCallback((c: Canvas) => {
    base.current = c.version;
    setCanvas(c);
    setNodes(c.nodes);
  }, []);

  useEffect(() => {
    api.canvas(id).then(adopt, onError);
    return stream.listen('canvas:' + id, (e) => {
      if (e.type !== 'canvas') return;
      if (e.canvas.version <= base.current) return; // our own save echoing back
      const d = dirty.current;
      if (d.changed.size || d.deleted.size) return; // the pending save will merge
      adopt(e.canvas);
      if (e.canvas.updatedBy !== 'can') flash(`Updated by @${e.canvas.updatedBy}`);
    });
  }, [id, stream, adopt, onError]);

  useEffect(() => localStorage.setItem('atlas.view.' + id, JSON.stringify(view)), [id, view]);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 2500);
  };

  // Debounced save with merge on conflict: server nodes + Can's changed nodes − Can's deleted nodes.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async function attempt() {
      const sent = { changed: new Set(dirty.current.changed), deleted: new Set(dirty.current.deleted) };
      try {
        const saved = await api.saveCanvas(id, nodesRef.current, base.current);
        base.current = saved.version;
        setCanvas(saved);
        for (const n of sent.changed) dirty.current.changed.delete(n);
        for (const n of sent.deleted) dirty.current.deleted.delete(n);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.body.current) {
          const current = e.body.current as Canvas;
          const mine = new Map(nodesRef.current.filter((n) => dirty.current.changed.has(n.id)).map((n) => [n.id, n]));
          const merged = current.nodes.filter((n) => !dirty.current.deleted.has(n.id)).map((n) => mine.get(n.id) ?? n);
          for (const [nid, n] of mine) if (!merged.some((m) => m.id === nid)) merged.push(n);
          base.current = current.version;
          setNodes(merged);
          nodesRef.current = merged;
          flash(`Merged with @${current.updatedBy}'s changes`);
          await attempt();
        } else onError(e);
      }
    }, 500);
  }, [id, onError]);

  const update = useCallback(
    (nid: string, patch: Partial<CanvasNode>) => {
      setNodes((ns) => ns.map((n) => (n.id === nid ? ({ ...n, ...patch } as CanvasNode) : n)));
      dirty.current.changed.add(nid);
      save();
    },
    [save],
  );
  const remove = (nid: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nid));
    dirty.current.deleted.add(nid);
    dirty.current.changed.delete(nid);
    setSelected(null);
    save();
  };
  const add = (kind: CanvasNodeKind) => {
    const r = rendererOf(kind);
    const rect = board.current!.getBoundingClientRect();
    const [w, h] = r.size;
    const cx = (rect.width / 2 - view.x) / view.z;
    const cy = (rect.height / 2 - view.y) / view.z;
    // Cascade so a new node never lands exactly on another one.
    let x = Math.round(cx - w / 2), y = Math.round(cy - h / 2);
    while (nodesRef.current.some((n) => Math.abs(n.x - x) < 24 && Math.abs(n.y - y) < 24)) {
      x += 40;
      y += 40;
    }
    const node = { id: newId(), kind, title: r.label, x, y, w, h, cardId: null, ...r.create() } as CanvasNode;
    setNodes((ns) => [...ns, node]);
    dirty.current.changed.add(node.id);
    setSelected(node.id);
    if (r.modal) setDrawingOpen(node.id);
    else setEditing(node.id);
    save();
  };

  const fit = () => {
    if (!nodes.length || !board.current) return;
    const rect = board.current.getBoundingClientRect();
    const minX = Math.min(...nodes.map((n) => n.x)), minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.w)), maxY = Math.max(...nodes.map((n) => n.y + n.h));
    const z = Math.min(1.5, Math.max(0.1, Math.min((rect.width - 80) / (maxX - minX), (rect.height - 80) / (maxY - minY))));
    setView({ z, x: 40 - minX * z + (rect.width - 80 - (maxX - minX) * z) / 2, y: 40 - minY * z + (rect.height - 80 - (maxY - minY) * z) / 2 });
  };

  // Wheel: pinch / ctrl+wheel zooms around the cursor; otherwise pans (trackpad-friendly).
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.node-body.scrollable, .node-code, .node-url-edit')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const z = Math.min(3, Math.max(0.1, v.z * Math.exp(-e.deltaY * 0.01)));
          const px = e.clientX - rect.left, py = e.clientY - rect.top;
          return { z, x: px - ((px - v.x) * z) / v.z, y: py - ((py - v.y) * z) / v.z };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [canvas !== null]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || drawingOpen || !selected) return;
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') remove(selected);
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Pointer drag helper: pan the board, move a node, or resize it. */
  const drag = (e: RPointerEvent, onMove: (dx: number, dy: number) => void, onEnd?: () => void) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    setInteracting(true);
    const move = (ev: PointerEvent) => onMove(ev.clientX - sx, ev.clientY - sy);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setInteracting(false);
      onEnd?.();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const drawingNode = useMemo(() => nodes.find((n) => n.id === drawingOpen && n.kind === 'drawing'), [nodes, drawingOpen]) as
    | Extract<CanvasNode, { kind: 'drawing' }>
    | undefined;

  if (!canvas) return <div className="canvas-board loading">Loading canvas…</div>;

  return (
    <div className="canvas-main">
      <div className="canvas-toolbar">
        <input
          className="canvas-name"
          defaultValue={canvas.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== canvas.name && api.renameCanvas(id, e.target.value.trim()).catch(onError)}
        />
        <span className="sep" />
        {KINDS.map((k) => (
          <button key={k} className="tool" onClick={() => add(k)} title={'Add ' + RENDERERS[k].label}>
            <span className="icon">{RENDERERS[k].icon}</span> {RENDERERS[k].label}
          </button>
        ))}
        <span className="sep" />
        <button className="tool" onClick={fit} title="Fit everything">
          ⤢ Fit
        </button>
        <span className="zoom">{Math.round(view.z * 100)}%</span>
        <span className="version">
          v{canvas.version} · {canvas.updatedBy}
        </span>
        <button
          className="ghost danger"
          onClick={() => confirm(`Delete canvas « ${canvas.name} »?`) && api.deleteCanvas(id).then(props.onDeleted, onError)}
        >
          Delete
        </button>
      </div>
      <div
        ref={board}
        className={'canvas-board' + (interacting ? ' interacting' : '')}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.z}px ${24 * view.z}px` }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          setSelected(null);
          setEditing(null);
          const start = view;
          drag(e, (dx, dy) => setView({ ...start, x: start.x + dx, y: start.y + dy }));
        }}
      >
        <div className="canvas-layer" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          {nodes.map((n) => {
            const r = rendererOf(n.kind);
            const isEditing = editing === n.id;
            return (
              <div
                key={n.id}
                className={'cnode ' + n.kind + (selected === n.id ? ' selected' : '') + (isEditing ? ' editing' : '')}
                style={{ left: n.x, top: n.y, width: n.w, height: n.h }}
                onPointerDown={() => setSelected(n.id)}
              >
                <div
                  className="cnode-head"
                  onPointerDown={(e) => {
                    setSelected(n.id);
                    const sx = n.x, sy = n.y;
                    drag(e, (dx, dy) => update(n.id, { x: Math.round(sx + dx / view.z), y: Math.round(sy + dy / view.z) }));
                  }}
                  onDoubleClick={() => (r.modal ? setDrawingOpen(n.id) : setEditing(isEditing ? null : n.id))}
                >
                  <span className="icon">{r.icon}</span>
                  {isEditing ? (
                    <input className="cnode-title-edit" value={n.title} onPointerDown={(e) => e.stopPropagation()} onChange={(e) => update(n.id, { title: e.target.value })} />
                  ) : (
                    <span className="cnode-title">{n.title || r.label}</span>
                  )}
                  {n.cardId && (
                    <button className="chip-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => props.onOpenCard(n.cardId!)}>
                      {n.cardId}
                    </button>
                  )}
                  <span className="cnode-actions" onPointerDown={(e) => e.stopPropagation()}>
                    <button onClick={() => (r.modal ? setDrawingOpen(n.id) : setEditing(isEditing ? null : n.id))}>{isEditing ? 'Done' : 'Edit'}</button>
                    {n.kind === 'url' && (
                      <a href={(n as { url: string }).url} target="_blank" rel="noreferrer" title="Open in a new tab">
                        ↗
                      </a>
                    )}
                    <button onClick={() => remove(n.id)} title="Delete node">
                      ✕
                    </button>
                  </span>
                </div>
                <div className={'node-body' + (n.kind === 'markdown' ? ' scrollable' : '')}>
                  {isEditing && r.Editor ? <r.Editor node={n} onChange={(p) => update(n.id, p)} /> : <r.View node={n} interactive={!interacting && selected === n.id} />}
                </div>
                <div
                  className="cnode-resize"
                  onPointerDown={(e) => {
                    const sw = n.w, sh = n.h;
                    drag(e, (dx, dy) => update(n.id, { w: Math.max(120, Math.round(sw + dx / view.z)), h: Math.max(80, Math.round(sh + dy / view.z)) }));
                  }}
                />
              </div>
            );
          })}
        </div>
        {nodes.length === 0 && (
          <div className="board-hint">Add a drawing, an HTML component, a running app or a note from the toolbar. Agents can write here with canvas tools.</div>
        )}
        {notice && <div className="canvas-notice">{notice}</div>}
      </div>
      {drawingNode && (
        <Suspense fallback={<div className="drawing-modal loading">Loading editor…</div>}>
          <DrawingEditor
            title={drawingNode.title}
            scene={drawingNode.scene}
            onClose={(scene: DrawingScene | null) => {
              if (scene) update(drawingNode.id, { scene });
              setDrawingOpen(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}
