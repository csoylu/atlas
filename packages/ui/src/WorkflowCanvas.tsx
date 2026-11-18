import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Agent, Card, Workflow, WorkflowEdge, WorkflowNode, WorkflowNodeKind, WorkflowRun, WorkflowRunStep } from '@atlas/shared';
import { api } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { HeaderActions } from './ScreenHeader.tsx';
import type { MessageStream } from './useMessages.ts';
import { useMedia } from './Inbox.tsx';
import { KindIcon, StepPanel } from './WorkflowStepPanel.tsx';
import {
  KIND_LABEL,
  NODE_W,
  RUN_LABEL,
  STATE_LABEL,
  chipClass,
  draftPath,
  duration,
  edgePath,
  exitTarget,
  exitsOf,
  freeSpot,
  newNodeId,
  nodeClass,
  nodeMeta,
  nodeRunState,
  nodeTitle,
  refOf,
  relative,
  stepOrder,
  stepState,
  takenEdges,
  when,
  wire,
  withoutNode,
  type Pt,
} from './workflowView.ts';

/**
 * One workflow's canvas (#171, design §9). Edit mode: drag nodes, drag an exit onto a step to wire it, click a link to
 * remove it, add steps, undo, zoom; the right panel edits the selected step; every change autosaves through the
 * revision check. Runs mode: each node's latest state in the chosen run, the path taken, the run list and step log.
 * Nodes are absolutely placed divs at their saved x/y; links are SVG paths drawn here (no graph library). On a phone:
 * the steps in order with their exits, the runs, Run now and on/off; no editing.
 */

type Graph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };
type Save = { state: 'saved'; at: number } | { state: 'saving' } | { state: 'error'; message: string };
/** A node's ports, relative to its top-left corner (px at 100 %), measured from the DOM. */
type Ports = { h: number; input: Pt; exits: Record<string, Pt> };

const ADD: { kind: Exclude<WorkflowNodeKind, 'trigger'>; label: string; help: string }[] = [
  { kind: 'agent', label: 'Agent step', help: 'An agent runs a prompt as a task. Exits: done, failed.' },
  { kind: 'approval', label: 'Approval', help: 'A task blocked on you, in the Inbox. Exits: approved, rejected.' },
  { kind: 'condition', label: 'Condition', help: 'An exact test picks yes or no.' },
];
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

function blank(kind: Exclude<WorkflowNodeKind, 'trigger'>, id: string, at: { x: number; y: number }, g: Graph): WorkflowNode {
  if (kind === 'agent') return { id, kind, ...at, config: { title: '', agentId: null, prompt: '', newTaskEachRun: true } };
  if (kind === 'approval') return { id, kind, ...at, config: { title: '', question: '' } };
  const counted = g.nodes.find((n) => n.kind === 'agent')?.id ?? 'trigger';
  return { id, kind, ...at, config: { test: 'ranFewer', title: '', node: counted, times: 3 } };
}

export function WorkflowCanvas(props: {
  workflow: Workflow;
  agents: Agent[];
  cards: Card[];
  mode: 'edit' | 'runs';
  runId: string | null;
  initialSelect: string | null;
  stream: MessageStream;
  go(hash: string): void;
  onOpenCard(id: string): void;
  onError(e: unknown): void;
}) {
  const { workflow: w, mode, onError } = props;
  const phone = useMedia('(max-width: 640px)');
  const base = `#/workflows/${w.id}`;

  /* ── The graph being edited, saved through the revision check ── */
  const [g, setG] = useState<Graph>({ nodes: w.nodes, edges: w.edges });
  const [save, setSave] = useState<Save>({ state: 'saved', at: new Date(w.updatedAt).getTime() });
  const rev = useRef(w.revision);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const latest = useRef(g);
  const undo = useRef<Graph[]>([]);
  const undoKey = useRef<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const flush = useCallback(() => {
    if (inFlight.current || !dirty.current) return;
    inFlight.current = true;
    const sent = latest.current;
    setSave({ state: 'saving' });
    api.saveWorkflowGraph(w.id, { revision: rev.current, ...sent }).then(
      (saved) => {
        rev.current = saved.revision;
        inFlight.current = false;
        if (latest.current === sent) {
          dirty.current = false;
          setSave({ state: 'saved', at: Date.now() });
        } else flush();
      },
      (e: Error) => {
        inFlight.current = false;
        setSave({ state: 'error', message: e.message });
      },
    );
  }, [w.id]);
  // Leaving the canvas saves what is pending.
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
      flush();
    },
    [flush],
  );

  const apply = (next: Graph, delay: number) => {
    latest.current = next;
    setG(next);
    dirty.current = true;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flush, delay);
  };
  /** Change the graph: one undo step per action (`key`: typing in one field is one action). */
  const change = (next: Graph, key: string | null = null) => {
    if (key === null || key !== undoKey.current) {
      undo.current = [...undo.current.slice(-49), latest.current];
      setCanUndo(true);
    }
    undoKey.current = key;
    apply(next, key ? 600 : 150);
  };
  const doUndo = () => {
    const prev = undo.current.pop();
    if (!prev) return;
    setCanUndo(undo.current.length > 0);
    undoKey.current = null;
    apply(prev, 150);
  };
  const reload = () => {
    undo.current = [];
    setCanUndo(false);
    dirty.current = false;
    rev.current = w.revision;
    latest.current = { nodes: w.nodes, edges: w.edges };
    setG(latest.current);
    setSave({ state: 'saved', at: new Date(w.updatedAt).getTime() });
  };
  // Saved elsewhere (an agent, another window) while nothing is pending here: take it.
  useEffect(() => {
    if (!dirty.current && !inFlight.current && w.revision > rev.current) {
      rev.current = w.revision;
      latest.current = { nodes: w.nodes, edges: w.edges };
      setG(latest.current);
    }
  }, [w]);

  /* ── Selection, zoom, add menu ── */
  const [sel, setSel] = useState<string | null>(props.initialSelect);
  const selected = g.nodes.find((n) => n.id === sel) ?? null;
  const [zoom, setZoom] = useState(1);
  const [menu, setMenu] = useState(false);
  const [sideOpen, setSideOpen] = useState(true);

  /* ── Runs ── */
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [detail, setDetail] = useState<WorkflowRun | null>(null);
  useEffect(() => {
    api.workflowRuns(w.id).then(setRuns, onError);
    return props.stream.listen('workflow-runs:' + w.id, (e) => {
      if (e.type !== 'workflowRun') return;
      setRuns((rs) => {
        const list = rs ?? [];
        return list.some((r) => r.id === e.run.id) ? list.map((r) => (r.id === e.run.id ? e.run : r)) : [e.run, ...list];
      });
      setDetail((d) => (d && d.id === e.run.id ? e.run : d));
    });
  }, [w.id]);
  const shownRunId = props.runId ?? runs?.find((r) => r.state !== 'skipped')?.id ?? runs?.[0]?.id ?? null;
  useEffect(() => {
    if (!shownRunId || detail?.id === shownRunId) return;
    api.workflowRun(shownRunId).then(setDetail, onError);
  }, [shownRunId]);
  const shown = detail && detail.id === shownRunId ? detail : null;
  // Re-render each 30 s: « Working · 3 min », « edited 2 min ago ».
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  /* ── Header: saved, Edit | Runs, on/off, Run now ── */
  const [starting, setStarting] = useState(false);
  const runNow = () => {
    setStarting(true);
    api
      .runWorkflow(w.id)
      .then((r) => {
        if (r.state === 'skipped') onError(new Error(r.reason ?? 'skipped'));
        setDetail(r);
        setRuns((rs) => (rs?.some((x) => x.id === r.id) ? rs : [r, ...(rs ?? [])]));
        setSideOpen(true);
        if (!phone) props.go(`${base}/runs/${r.id}`);
      }, onError)
      .finally(() => setStarting(false));
  };
  const trigger = g.nodes.find((n) => n.kind === 'trigger');
  const pastOnce = trigger?.kind === 'trigger' && trigger.config.kind === 'time' && trigger.config.repeat === 'at' && !!trigger.config.at && new Date(trigger.config.at) < new Date();
  const runCount = runs?.[0]?.number ?? w.lastRun?.number ?? 0;
  const header = (
    <HeaderActions>
      {!phone && mode === 'edit' && (
        <span className="wf-saved" role="status">
          {save.state === 'saving' ? 'saving…' : save.state === 'error' ? 'not saved' : `saved · edited ${relative(new Date(save.at).toISOString())}`}
        </span>
      )}
      {!phone && (
        <div className="segmented wf-seg">
          <button className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} onClick={() => props.go(base)}>
            Edit
          </button>
          <button className={mode === 'runs' ? 'on' : ''} aria-pressed={mode === 'runs'} onClick={() => props.go(`${base}/runs`)}>
            Runs{runCount ? ` · ${runCount}` : ''}
          </button>
        </div>
      )}
      <label className="wf-onoff" title={w.enabled ? 'On: the trigger fires' : "Off: the trigger doesn't fire"}>
        <span>{w.enabled ? 'On' : 'Off'}</span>
        <span className="switch">
          <input type="checkbox" aria-label={w.enabled ? 'Turn off' : 'Turn on'} checked={w.enabled} disabled={pastOnce && !w.enabled} onChange={(e) => api.updateWorkflow(w.id, { enabled: e.target.checked }).catch(onError)} />
          <span />
        </span>
      </label>
      <button className="head-btn" disabled={starting} onClick={runNow} title="Start a run now (works when off too)">
        {starting ? 'Starting…' : 'Run now'}
      </button>
    </HeaderActions>
  );

  const off = !w.enabled ? <div className="wf-off">Off: the trigger doesn't fire. Run now still works; runs already started finish.</div> : null;

  if (phone)
    return (
      <div className="wf-body phone">
        {header}
        <div className="wf-phone">
          {off}
          <h2 className="wf-h">Steps</h2>
          <div className="wf-phone-steps">
            {stepOrder(g).map((n, i) => (
              <NodeCard key={n.id} n={n} g={g} run={null} cards={props.cards} phone index={i} onOpenCard={props.onOpenCard} />
            ))}
          </div>
          <p className="wf-sum">Edit the steps on a wider screen.</p>
          <h2 className="wf-h">Runs</h2>
          <RunsPanel w={w} g={g} runs={runs} run={shown} cards={props.cards} pick={(id) => props.go(`${base}/runs/${id}`)} onOpenCard={props.onOpenCard} onError={onError} />
        </div>
      </div>
    );

  return (
    <div className={'wf-body' + (mode === 'runs' ? ' runs' : '')}>
      {header}
      <Plane
        g={g}
        mode={mode}
        run={mode === 'runs' ? shown : null}
        cards={props.cards}
        sel={mode === 'edit' ? sel : null}
        zoom={zoom}
        setZoom={setZoom}
        change={change}
        onSelect={(id) => {
          setSel(id);
          if (id) setSideOpen(true);
        }}
        onOpenCard={props.onOpenCard}
        onUndo={doUndo}
        top={
          <>
            {off}
            {save.state === 'error' && (
              <div className="wf-refused" role="alert">
                <span>Not saved: {save.message}</span>
                <button className="linklike" onClick={flush}>
                  Try again
                </button>
                <button className="linklike" onClick={reload}>
                  Reload the saved version
                </button>
              </div>
            )}
          </>
        }
        tools={
          mode === 'edit' && (
            <div className="wf-tools">
              <button className="head-btn" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}>
                + Add step
              </button>
              <button className="head-btn" disabled={!canUndo} onClick={doUndo} title="Undo (⌘Z)">
                Undo
              </button>
              {menu && (
                <div className="wf-add-menu" role="menu" onKeyDown={(e) => e.key === 'Escape' && setMenu(false)}>
                  {ADD.map((a) => (
                    <button
                      key={a.kind}
                      role="menuitem"
                      onClick={() => {
                        const id = newNodeId(g.nodes);
                        change({ nodes: [...g.nodes, blank(a.kind, id, freeSpot(g.nodes, selected ?? undefined), g)], edges: g.edges });
                        setSel(id);
                        setSideOpen(true);
                        setMenu(false);
                      }}
                    >
                      <KindIcon kind={a.kind} />
                      <span>
                        <b>{a.label}</b>
                        <span className="help">{a.help}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        }
      />
      {mode === 'edit' && selected && sideOpen && (
        <StepPanel key={selected.id} n={selected} g={g} w={w} agents={props.agents} change={change} onClose={() => setSideOpen(false)} onDeleted={() => setSel(null)} go={props.go} onError={onError} />
      )}
      {mode === 'runs' &&
        (sideOpen ? (
          <aside className="wf-side" aria-label="Runs">
            <div className="sd-head">
              <b>Runs</b>
              <span className="sd-sp" />
              <button className="sd-btn" aria-label="Close" onClick={() => setSideOpen(false)}>
                ✕
              </button>
            </div>
            <div className="wf-side-body">
              <RunsPanel w={w} g={g} runs={runs} run={shown} cards={props.cards} pick={(id) => props.go(`${base}/runs/${id}`)} onOpenCard={props.onOpenCard} onError={onError} />
            </div>
          </aside>
        ) : (
          <button className="head-btn wf-side-open" onClick={() => setSideOpen(true)}>
            Runs
          </button>
        ))}
    </div>
  );
}

/* ── The canvas: nodes, links, dragging and wiring ── */

function Plane(props: {
  g: Graph;
  mode: 'edit' | 'runs';
  run: WorkflowRun | null;
  cards: Card[];
  sel: string | null;
  zoom: number;
  setZoom(z: number): void;
  change(g: Graph, key?: string | null): void;
  onSelect(id: string | null): void;
  onOpenCard(id: string): void;
  onUndo(): void;
  top: ReactNode;
  tools: ReactNode;
}) {
  const { g, mode, zoom, run } = props;
  const edit = mode === 'edit';
  const canvasRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const [ports, setPorts] = useState<Record<string, Ports>>({});
  /** Dragging a node: its live position. */
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  /** Wiring: from an exit to the pointer, maybe over a step. */
  const [wiring, setWiring] = useState<{ from: string; exit: string; to: Pt; over: string | null } | null>(null);
  const nodes = drag ? g.nodes.map((n) => (n.id === drag.id ? { ...n, x: drag.x, y: drag.y } : n)) : g.nodes;

  // Measure each node's ports (relative to the node) after every render; new state only when they changed.
  useLayoutEffect(() => {
    const plane = planeRef.current;
    if (!plane) return;
    const next: Record<string, Ports> = {};
    plane.querySelectorAll<HTMLElement>(':scope > .wf-node[data-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      const at = (x: Element | null): Pt => {
        if (!x) return [0, 0];
        const p = x.getBoundingClientRect();
        return [Math.round((p.left + p.width / 2 - r.left) / zoom), Math.round((p.top + p.height / 2 - r.top) / zoom)];
      };
      const exits: Record<string, Pt> = {};
      el.querySelectorAll<HTMLElement>('[data-exit]').forEach((x) => (exits[x.dataset.exit!] = at(x.querySelector('.pd'))));
      next[el.dataset.id!] = { h: Math.round(r.height / zoom), input: at(el.querySelector('.wf-port.in')), exits };
    });
    if (JSON.stringify(next) !== JSON.stringify(ports)) setPorts(next);
  });

  const width = Math.max(560, ...nodes.map((n) => n.x + NODE_W + 80));
  const bottom = Math.max(0, ...nodes.map((n) => n.y + (ports[n.id]?.h ?? 120)));
  const height = Math.max(320, bottom + 80);
  const abs = (n: WorkflowNode, p: Pt): Pt => [n.x + p[0], n.y + p[1]];
  const taken = run ? takenEdges(run) : null;
  const toPlane = (e: { clientX: number; clientY: number }): Pt => {
    const r = planeRef.current!.getBoundingClientRect();
    return [(e.clientX - r.left) / zoom, (e.clientY - r.top) / zoom];
  };

  const startNodeDrag = (e: ReactPointerEvent, n: WorkflowNode) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-exit], button, a')) return;
    if (!edit) return;
    const [sx, sy] = toPlane(e);
    let moved = false;
    const pos = (ev: PointerEvent) => {
      const [x, y] = toPlane(ev);
      return { x: Math.max(0, Math.round(n.x + x - sx)), y: Math.max(0, Math.round(n.y + y - sy)), far: Math.hypot(x - sx, y - sy) >= 3 };
    };
    const move = (ev: PointerEvent) => {
      const p = pos(ev);
      if (!moved && !p.far) return;
      moved = true;
      setDrag({ id: n.id, x: p.x, y: p.y });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      props.onSelect(n.id);
      if (!moved) return;
      const p = pos(ev);
      props.change({ nodes: g.nodes.map((m) => (m.id === n.id ? { ...m, x: p.x, y: p.y } : m)), edges: g.edges });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const startWire = (e: ReactPointerEvent, from: string, exit: string) => {
    if (!edit || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const target = (ev: { clientX: number; clientY: number }) => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('.wf-plane > .wf-node[data-id]');
      const id = el?.dataset.id ?? null;
      return id && id !== from && g.nodes.find((n) => n.id === id)?.kind !== 'trigger' ? id : null;
    };
    setWiring({ from, exit, to: toPlane(e), over: null });
    const move = (ev: PointerEvent) => setWiring({ from, exit, to: toPlane(ev), over: target(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWiring(null);
      const to = target(ev);
      const had = g.edges.find((x) => x.from === from && x.exit === exit)?.to ?? null;
      // Dropped on a step: wire it there. Dropped off any step: unwire (the run ends at this exit).
      if (to !== had) props.change(wire(g, from, exit, to));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ⌘Z / Ctrl+Z undoes, Delete removes the selected step, while the focus is not in a field.
  useEffect(() => {
    if (!edit) return;
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        props.onUndo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && props.sel && g.nodes.find((n) => n.id === props.sel)?.kind !== 'trigger') {
        e.preventDefault();
        props.change(withoutNode(g, props.sel));
        props.onSelect(null);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const fit = () => {
    const c = canvasRef.current;
    if (!c) return;
    const z = Math.min(1.5, (c.clientWidth - 32) / width, (c.clientHeight - 32) / height);
    props.setZoom(Math.max(ZOOMS[0]!, Math.floor(z * 100) / 100));
  };
  const zoomStep = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001);
    if (next) props.setZoom(next);
  };

  const paths: ReactNode[] = [];
  for (const e of g.edges) {
    const s = nodes.find((n) => n.id === e.from);
    const t = nodes.find((n) => n.id === e.to);
    const sp = s && ports[s.id]?.exits[e.exit];
    const tp = t && ports[t.id];
    if (!s || !t || !sp || !tp) continue;
    const d = edgePath(abs(s, sp), abs(t, tp.input), s.y + (ports[s.id]?.h ?? 0), t.y, bottom);
    const fail = e.exit === 'failed' || e.exit === 'rejected';
    const k = `${e.from}:${e.exit}`;
    const cls = [fail ? 'fail' : '', taken ? (taken.has(k) ? 'taken' : 'dim') : ''].filter(Boolean).join(' ');
    paths.push(<path key={k} className={cls || undefined} d={d} data-edge={k} />);
    if (edit)
      paths.push(
        <path key={k + ':hit'} className="hit" d={d} data-edge-hit={k} onClick={() => props.change(wire(g, e.from, e.exit, null))}>
          <title>{`${nodeTitle(s, g.nodes)} · ${e.exit} → ${nodeTitle(t, g.nodes)}. Click to remove this link`}</title>
        </path>,
      );
  }
  if (wiring) {
    const s = nodes.find((n) => n.id === wiring.from);
    const sp = s && ports[s.id]?.exits[wiring.exit];
    const over = wiring.over ? nodes.find((n) => n.id === wiring.over) : undefined;
    const end: Pt = over && ports[over.id] ? abs(over, ports[over.id]!.input) : wiring.to;
    if (s && sp) paths.push(<path key="draft" className="draft" d={draftPath(abs(s, sp), end)} />);
  }
  const deselect = (e: ReactPointerEvent) => e.target === e.currentTarget && props.onSelect(null);

  return (
    <div className="wf-canvas-wrap">
      {props.top}
      <div className="wf-stage">
      <div className={'wf-canvas' + (edit ? ' edit' : ' runs') + (wiring ? ' wiring' : '')} ref={canvasRef} onPointerDown={deselect}>
        <div className="wf-scale" style={{ width: width * zoom, height: height * zoom }} onPointerDown={deselect}>
          <div className="wf-plane" ref={planeRef} style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }} onPointerDown={deselect}>
            <svg className="wf-edges" width={width} height={height} aria-hidden="true">
              {paths}
            </svg>
            {nodes.map((n) => (
              <NodeCard
                key={n.id}
                n={n}
                g={g}
                run={run}
                cards={props.cards}
                selected={props.sel === n.id}
                target={wiring?.over === n.id}
                wiringExit={wiring && wiring.from === n.id ? wiring.exit : null}
                onPointerDown={(e) => startNodeDrag(e, n)}
                onSelect={edit ? () => props.onSelect(n.id) : undefined}
                onExitDown={edit ? (e, exit) => startWire(e, n.id, exit) : undefined}
                onOpenCard={props.onOpenCard}
              />
            ))}
          </div>
        </div>
      </div>
      {props.tools}
      <div className="wf-zoom" role="group" aria-label="Zoom">
        <button aria-label="Zoom out" onClick={() => zoomStep(-1)} disabled={zoom <= ZOOMS[0]!}>
          −
        </button>
        <button title="Back to 100%" onClick={() => props.setZoom(1)}>
          {Math.round(zoom * 100)}%
        </button>
        <button aria-label="Zoom in" onClick={() => zoomStep(1)} disabled={zoom >= ZOOMS.at(-1)!}>
          +
        </button>
        <button onClick={fit}>Fit</button>
      </div>
      </div>
    </div>
  );
}

/** A step: kind, title, one faint line, its named exits with their ports, and in a run its state and task. */
function NodeCard(props: {
  n: WorkflowNode;
  g: Graph;
  run: WorkflowRun | null;
  cards: Card[];
  phone?: boolean;
  index?: number;
  selected?: boolean;
  target?: boolean;
  wiringExit?: string | null;
  onPointerDown?(e: ReactPointerEvent): void;
  /** Enter or Space on a focused node selects it. */
  onSelect?(): void;
  onExitDown?(e: ReactPointerEvent, exit: string): void;
  onOpenCard(id: string): void;
}) {
  const { n, g, run, phone } = props;
  const st = run ? nodeRunState(run, n.id) : null;
  const last = st?.steps.at(-1);
  const cls = ['wf-node', n.kind, st ? nodeClass(st.state) : '', props.selected ? 'sel' : '', props.target ? 'target' : ''].filter(Boolean).join(' ');
  return (
    <div
      className={cls}
      data-id={n.id}
      style={phone ? undefined : { left: n.x, top: n.y }}
      onPointerDown={props.onPointerDown}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && props.onSelect) {
          e.preventDefault();
          props.onSelect();
        }
      }}
      tabIndex={phone ? undefined : 0}
      aria-label={`${KIND_LABEL[n.kind]}: ${nodeTitle(n, g.nodes)}`}
    >
      {n.kind !== 'trigger' && !phone && <span className="wf-port in" />}
      <div className="wf-kind">
        {phone && props.index !== undefined && <span className="wf-num">{props.index + 1}</span>}
        <KindIcon kind={n.kind} />
        {KIND_LABEL[n.kind]}
      </div>
      <div className="wf-title">{nodeTitle(n, g.nodes)}</div>
      <div className="wf-meta">
        {n.kind === 'agent' && n.config.agentId && <AgentFace id={n.config.agentId} />}
        <span>{nodeMeta(n, g.nodes)}</span>
      </div>
      <div className="wf-outs">
        {exitsOf(n, g.edges).map((x) => (
          <span
            key={x.exit}
            className={'wf-out' + (x.failing ? ' fail' : '') + (x.to ? ' on' : '') + (props.wiringExit === x.exit ? ' drag' : '')}
            data-exit={x.exit}
            onPointerDown={props.onExitDown ? (e) => props.onExitDown!(e, x.exit) : undefined}
            title={props.onExitDown ? `${x.exit} → ${exitTarget(x, g.nodes)}. Drag onto a step to wire it` : undefined}
          >
            <span className="en">{x.exit}</span>
            {phone && (
              <span className="pto">
                <span aria-hidden="true">→ </span>
                {exitTarget(x, g.nodes)}
              </span>
            )}
            {!phone && <span className="pd" />}
          </span>
        ))}
      </div>
      {st && (
        <div className="wf-run">
          <div className="wf-run-now">
            {st.state === 'working' && <span className="spin" aria-hidden="true" />}
            <span className={'st-chip ' + chipClass(st.state)}>{STATE_LABEL[st.state]}</span>
            {last && st.state === 'working' && <span className="muted">{duration(last.startedAt, new Date().toISOString())}</span>}
            {last?.cardId && (
              <button className="linklike" onClick={() => props.onOpenCard(last.cardId!)}>
                {refOf(last.cardId, props.cards)}
              </button>
            )}
          </div>
          {st.steps.slice(0, -1).map((s) => (
            <div key={s.id} className="wf-round">
              {ordinal(s.round)} round: {STATE_LABEL[stepState(s)]}
              {s.cardId && (
                <>
                  {' · '}
                  <button className="linklike" onClick={() => props.onOpenCard(s.cardId!)}>
                    {refOf(s.cardId, props.cards)}
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Runs: the list and the chosen run's steps ── */

function RunsPanel(props: { w: Workflow; g: Graph; runs: WorkflowRun[] | null; run: WorkflowRun | null; cards: Card[]; pick(id: string): void; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const { runs, run, g } = props;
  if (!runs) return <p className="wf-sum">Loading runs…</p>;
  if (!runs.length) return <p className="wf-sum">No runs yet. Run now starts one{props.w.enabled && props.w.nextRunAt ? `; the trigger fires ${when(props.w.nextRunAt)}` : ''}.</p>;
  const open = !!run && (run.state === 'running' || run.state === 'waiting');
  return (
    <>
      <div className="wf-runs">
        {runs.map((r) => (
          <button key={r.id} className={r.id === run?.id ? 'on' : ''} aria-current={r.id === run?.id || undefined} onClick={() => props.pick(r.id)}>
            <span className={'st-chip ' + chipClass(r.state)}>{RUN_LABEL[r.state]}</span>
            <span className="nm">Run {r.number}</span>
            <span className="when">{r.state === 'running' || r.state === 'waiting' ? relative(r.startedAt).replace(' ago', '') : when(r.startedAt)}</span>
          </button>
        ))}
      </div>
      {run && (
        <div className="wf-run-detail">
          <p className="wf-h2">
            Run {run.number} · {run.trigger === 'manual' ? 'by hand' : 'by its trigger'} · {open ? `started ${relative(run.startedAt)}` : run.endedAt ? `took ${duration(run.startedAt, run.endedAt)}` : when(run.startedAt)}
          </p>
          <ol className="wf-steps-log">
            {(run.steps ?? []).map((s) => (
              <StepLine key={s.id} s={s} g={g} cards={props.cards} onOpenCard={props.onOpenCard} />
            ))}
          </ol>
          {!open && run.reason && (
            <p className={'wf-sum' + (run.state === 'failed' ? ' bad' : '')}>
              <b>{RUN_LABEL[run.state]}</b>: {run.reason}
            </p>
          )}
          {open && (
            <p className="wf-sum">
              Stop run closes its open tasks.{' '}
              <button className="linklike" onClick={() => api.stopWorkflowRun(run.id).catch(props.onError)}>
                Stop run
              </button>
            </p>
          )}
        </div>
      )}
    </>
  );
}

function StepLine({ s, g, cards, onOpenCard }: { s: WorkflowRunStep; g: Graph; cards: Card[]; onOpenCard(id: string): void }) {
  const n = g.nodes.find((x) => x.id === s.nodeId);
  const st = stepState(s);
  const dot = st === 'working' ? 'wk' : st === 'waiting' ? 'bk' : st === 'failed' || st === 'rejected' ? 'bad' : st === 'stopped' ? 'off' : 'ok';
  const who = n?.kind === 'agent' && n.config.agentId ? ` · @${n.config.agentId}` : '';
  const exit = s.exit && s.kind !== 'trigger' ? ` · ${s.exit}` : '';
  const round = s.round > 1 ? ` · ${ordinal(s.round)} round` : '';
  const title = s.kind === 'trigger' ? 'Trigger' : n ? nodeTitle(n, g.nodes) : `${s.nodeId} (deleted)`;
  const say = s.state === 'running' ? `Working for ${duration(s.startedAt, new Date().toISOString())}` : s.state === 'waiting' ? 'Waiting for you' : s.summary;
  return (
    <li>
      <span className={'d ' + dot} aria-label={STATE_LABEL[st]} />
      <span className="t">
        {title}
        {who}
        {exit}
        {round}
      </span>
      {s.cardId ? (
        <button className="linklike r" onClick={() => onOpenCard(s.cardId!)}>
          {refOf(s.cardId, cards)}
        </button>
      ) : (
        <span className="r">{new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
      )}
      {say && <span className="s">{say}</span>}
    </li>
  );
}
