import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { WORKFLOW_FAILING_EXITS, type RunWorkflow, type Agent, type Card, type Workflow, type WorkflowEdge, type WorkflowNode, type WorkflowNodeKind, type WorkflowRun, type WorkflowRunStep } from '@atlas/shared';
import { api } from './api.ts';
import { AgentFace } from './AgentFace.tsx';
import { HeaderActions } from './ScreenHeader.tsx';
import type { MessageStream } from './useMessages.ts';
import { useMedia } from './Inbox.tsx';
import { KindIcon, StepPanel } from './WorkflowStepPanel.tsx';
import { ApprovalBanner } from './WorkflowApproval.tsx';
import { RunOnPicker, RunStart, RunKnows, LoopGuardBanner, PLAY } from './WorkflowRunParts.tsx';
import {
  ADD_STEPS,
  addStep,
  clampBox,
  type AddKind,
  KIND_LABEL,
  kindLine,
  NODE_W,
  RUN_LABEL,
  STATE_LABEL,
  chipClass,
  draftPath,
  duration,
  edgeLabelAt,
  edgePath,
  exitTarget,
  exitsOf,
  loopGuardHit,
  nodeClass,
  nodeMeta,
  nodeRunState,
  nodeTitle,
  prLabel,
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
import { EmptyState } from './Kit.tsx';

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

/** Height of the ghost node while the add menu is open (px at 100 %). */
const GHOST_H = 96;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);

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
  // A link to a step (#/workflows/<id>/step/<node>, e.g. from the Inbox or a task) selects it, also once open.
  useEffect(() => {
    if (props.initialSelect) {
      setSel(props.initialSelect);
      setSideOpen(true);
    }
  }, [props.initialSelect]);
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
  /** « Run on a task… » / « Run on a PR… » (#259): an event workflow runs on what its event would bring. */
  const [picking, setPicking] = useState(false);
  const runNow = (on: RunWorkflow = {}) => {
    setStarting(true);
    setPicking(false);
    api
      .runWorkflow(w.id, on)
      .then((r) => {
        if (r.state === 'skipped') onError(new Error(r.reason ?? 'skipped'));
        setDetail(r);
        setRuns((rs) => (rs?.some((x) => x.id === r.id) ? rs : [r, ...(rs ?? [])]));
        setSideOpen(true);
        props.go(`${base}/runs/${r.id}`);
      }, onError)
      .finally(() => setStarting(false));
  };
  const trigger = g.nodes.find((n) => n.kind === 'trigger');
  const runOn = trigger?.kind === 'trigger' && (trigger.config.kind === 'task' || trigger.config.kind === 'pr') ? trigger.config.kind : null;
  const pastOnce = trigger?.kind === 'trigger' && trigger.config.kind === 'time' && trigger.config.repeat === 'at' && !!trigger.config.at && new Date(trigger.config.at) < new Date();
  const runCount = runs?.[0]?.number ?? w.lastRun?.number ?? 0;
  // « Reset to default » (#263): in the header; on a phone, under the steps (the header has no room for it).
  // « Reset to default » keeps the agents chosen now (#335 2a): its confirm says which.
  const agentOf = (id: string) => {
    const n = w.nodes.find((x) => x.id === id);
    return n?.kind === 'agent' && n.config.agentId ? `@${n.config.agentId}` : null;
  };
  const resetText = () => {
    const [a, b] = [agentOf('review'), agentOf('review2')];
    const kept =
      a || b
        ? ` The agents chosen now stay: ${[a && `${a} in « Review the PR »`, b && `${b} in « Review the reviewer's PR »`].filter(Boolean).join(' and ')}${a ? `, and « Built by another agent? » keeps testing for ${a}` : ''}.`
        : ' No agent is chosen in its review steps yet: choose them after.';
    return `Reset « ${w.name} » to the default? Its nine steps, their links and their layout come back, and your changes to them are lost.${kept} On/off and its runs stay.`;
  };
  const resetButton = (
    <button
      className="btn ghost"
      title="Bring back the default Review workflow's nine steps, their links and layout"
      onClick={() => {
        if (!window.confirm(resetText())) return;
        api.resetWorkflow(w.id).catch(onError);
      }}
    >
      Reset to default
    </button>
  );
  /** Agent steps with no agent (#334): a run stops there; the bar's button selects the first one. */
  const empty = g.nodes.filter((n) => n.kind === 'agent' && !n.config.agentId);
  const noAgent = empty.length ? (
    <div className="wf-off wf-noagent" role="status">
      <span>
        <b>No agent in {empty.map((n) => `« ${nodeTitle(n, g.nodes)} »`).join(' and ')}.</b> {empty.every((n) => n.kind === 'agent' && n.config.verdict) ? 'Pull requests' : 'Runs'} stop there
        until you choose one.
      </span>
      {mode === 'edit' && !phone && (
        <button
          className="btn small"
          onClick={() => {
            setSel(empty[0]!.id);
            setSideOpen(true);
          }}
        >
          Choose the agent
        </button>
      )}
    </div>
  ) : null;
  const header = (
    <HeaderActions>
      {!phone && mode === 'edit' && (
        <span className="wf-saved" role="status">
          {save.state === 'saving' ? 'saving…' : save.state === 'error' ? 'not saved' : `saved · edited ${relative(new Date(save.at).toISOString())}`}
        </span>
      )}
      {!phone && mode === 'edit' && w.origin === 'review' && resetButton}
      {(
        <div className="segmented wf-seg">
          <button className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} onClick={() => props.go(base)}>
            {phone ? 'Steps' : 'Edit'}
          </button>
          <button className={mode === 'runs' ? 'on' : ''} aria-pressed={mode === 'runs'} onClick={() => props.go(`${base}/runs`)}>
            Runs{runCount && !phone ? ` · ${runCount}` : ''}
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
      <span className="wf-runbtn">
        <button
          className="btn"
          disabled={starting}
          aria-expanded={runOn ? picking : undefined}
          aria-label={phone ? (runOn ? `Run on a ${runOn === 'task' ? 'task' : 'PR'}…` : 'Run now') : undefined}
          onClick={() => (runOn ? setPicking(!picking) : runNow())}
          title={runOn ? `Start a run on a ${runOn === 'task' ? 'task' : 'pull request'} of your choice (works when off too)` : 'Start a run now (works when off too)'}
        >
          {phone ? PLAY : starting ? 'Starting…' : runOn === 'task' ? 'Run on a task…' : runOn === 'pr' ? 'Run on a PR…' : 'Run now'}
        </button>
        {picking && runOn && <RunOnPicker kind={runOn} w={w} cards={props.cards} onRun={runNow} onClose={() => setPicking(false)} />}
      </span>
    </HeaderActions>
  );

  const unapproved = w.commandSteps.filter((c) => !c.approved).map((c) => c.nodeId);
  const off = loopGuardHit(w) ? (
    <LoopGuardBanner
      w={w}
      onLimit={() => {
        const t = g.nodes.find((n) => n.kind === 'trigger');
        setSel(t?.id ?? null);
        setSideOpen(true);
        props.go(base);
      }}
      onError={onError}
    />
  ) : !w.enabled && !w.commandSteps.some((c) => !c.approved) ? (
    <div className="wf-off">
      {w.origin === 'review'
        ? "Off: no pull request of this project is reviewed or merged. Its tasks In review say so, with Turn it on and Validate by hand."
        : "Off: the trigger doesn't fire. Run now still works; runs already started finish."}
    </div>
  ) : null;

  if (phone)
    return (
      <div className="wf-body phone">
        {header}
        <div className="wf-phone">
          <ApprovalBanner w={w} onError={onError} />
          {off}
          {noAgent}
          {mode === 'runs' && (
            <>
              <RunsPanel w={w} g={g} runs={runs} run={shown} cards={props.cards} pick={(id) => props.go(`${base}/runs/${id}`)} onOpenCard={props.onOpenCard} onError={onError} />
              {shown && <h2 className="wf-h">Run {shown.number} on the steps</h2>}
            </>
          )}
          <div className="wf-phone-steps">
            {stepOrder(g).map((n, i) => (
              <NodeCard key={n.id} n={n} g={g} run={mode === 'runs' ? shown : null} cards={props.cards} phone index={i} needsOk={unapproved.includes(n.id)} onOpenCard={props.onOpenCard} />
            ))}
          </div>
          {mode === 'edit' && <p className="wf-sum">Edit the steps on a wider screen.</p>}
          {mode === 'edit' && w.origin === 'review' && <div className="wf-phone-reset">{resetButton}</div>}
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
        unapproved={unapproved}
        onAdded={(id) => {
          setSel(id);
          setSideOpen(true);
        }}
        top={
          <>
            <ApprovalBanner w={w} onError={onError} />
            {off}
            {noAgent}
            {save.state === 'error' && (
              <div className="state-err bar wf-refused" role="alert">
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
              <button className="btn" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(!menu)}>
                + Add step
              </button>
              <button className="btn" disabled={!canUndo} onClick={doUndo} title="Undo (⌘Z)">
                Undo
              </button>
              {menu && (
                <AddMenu
                  onPick={(kind) => {
                    const r = addStep(g, kind, selected ? { from: selected } : null);
                    change(r.graph);
                    setSel(r.id);
                    setSideOpen(true);
                    setMenu(false);
                  }}
                  onClose={() => setMenu(false)}
                />
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
          <button className="btn wf-side-open" onClick={() => setSideOpen(true)}>
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
  /** Command steps waiting for Master's OK. */
  unapproved: string[];
  /** A step was added by dropping an exit on empty canvas: select it. */
  onAdded(id: string): void;
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
  /** An exit dropped on empty canvas (#262): the add menu at the drop point, a ghost node already wired. */
  const [adding, setAdding] = useState<{ from: string; exit: string; at: Pt; menu: Pt } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
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
    const start = toPlane(e);
    setAdding(null);
    setWiring({ from, exit, to: start, over: null });
    const move = (ev: PointerEvent) => setWiring({ from, exit, to: toPlane(ev), over: target(ev) });
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setWiring(null);
      const to = target(ev);
      const had = g.edges.find((x) => x.from === from && x.exit === exit)?.to ?? null;
      // Dropped on a step: wire it there.
      if (to) {
        if (to !== had) props.change(wire(g, from, exit, to));
        return;
      }
      // Dropped on empty canvas, away from the exit: the add menu opens there, with a ghost node wired to the exit.
      const [x, y] = toPlane(ev);
      const onCanvas = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.wf-canvas') && !document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.wf-node');
      if (!onCanvas || Math.hypot(x - start[0], y - start[1]) < 24) return;
      const st = stageRef.current!.getBoundingClientRect();
      setAdding({ from, exit, at: [Math.max(0, Math.round(x)), Math.max(0, Math.round(y - GHOST_H / 2))], menu: [ev.clientX - st.left, ev.clientY - st.top] });
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
  /** Exit names on the edges that go back to an earlier column (#259): where they cross, a line needs its name. */
  const labels: ReactNode[] = [];
  const placed: [number, number, number][] = [];
  // A selected step lights the edges coming into it and dims the others (colour tokens, no transparency).
  const lit = edit && props.sel && !wiring ? props.sel : null;
  for (const e of g.edges) {
    const s = nodes.find((n) => n.id === e.from);
    const t = nodes.find((n) => n.id === e.to);
    const sp = s && ports[s.id]?.exits[e.exit];
    const tp = t && ports[t.id];
    if (!s || !t || !sp || !tp) continue;
    const a = abs(s, sp);
    const b = abs(t, tp.input);
    const srcBottom = s.y + (ports[s.id]?.h ?? 0);
    const d = edgePath(a, b, srcBottom, t.y, bottom);
    const fail = (WORKFLOW_FAILING_EXITS as readonly string[]).includes(e.exit);
    const k = `${e.from}:${e.exit}`;
    const state = taken ? (taken.has(k) ? 'taken' : 'dim') : lit ? (e.to === lit ? 'lit' : 'dim') : '';
    const cls = [fail ? 'fail' : '', state].filter(Boolean).join(' ');
    paths.push(<path key={k} className={cls || undefined} d={d} data-edge={k} />);
    const at = edgeLabelAt(a, b, srcBottom, t.y, bottom);
    // Two back edges in the same lane between the same columns: their names side by side, not on top of each other.
    if (at) {
      const lo = Math.min(a[0], b[0]) + 8;
      const hi = Math.max(a[0], b[0]);
      const pos = labelSpot(at, e.exit, placed, lo, hi);
      at[0] = pos;
      placed.push([at[0], at[1], labelW(e.exit)]);
    }
    if (at)
      labels.push(
        <span key={k + ':label'} className={'wf-elabel' + (cls ? ' ' + cls : '')} style={{ left: at[0], top: at[1] }} data-edge-label={k}>
          {e.exit}
        </span>,
      );
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
  if (adding) {
    const s = nodes.find((n) => n.id === adding.from);
    const sp = s && ports[s.id]?.exits[adding.exit];
    if (s && sp) paths.push(<path key="ghost" className="draft" d={draftPath(abs(s, sp), [adding.at[0], adding.at[1] + GHOST_H / 2])} />);
  }
  const deselect = (e: ReactPointerEvent) => e.target === e.currentTarget && props.onSelect(null);
  const pick = (kind: AddKind) => {
    const from = adding && g.nodes.find((n) => n.id === adding.from);
    setAdding(null);
    if (!from || !adding) return;
    const r = addStep(g, kind, { from, exit: adding.exit, at: { x: adding.at[0], y: adding.at[1] } });
    props.change(r.graph);
    props.onAdded(r.id);
  };

  return (
    <div className="wf-canvas-wrap">
      {props.top}
      <div className="wf-stage" ref={stageRef}>
        <div className={'wf-canvas' + (edit ? ' edit' : ' runs') + (wiring ? ' wiring' : '') + (lit ? ' litmode' : '')} ref={canvasRef} onPointerDown={deselect}>
          <div className="wf-scale" style={{ width: width * zoom, height: height * zoom }} onPointerDown={deselect}>
            <div className="wf-plane" ref={planeRef} style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }} onPointerDown={deselect}>
              <svg className="wf-edges" width={width} height={height} aria-hidden="true">
                {paths}
              </svg>
              {labels}
              {adding && (
                <div className="wf-ghost" style={{ left: adding.at[0], top: adding.at[1], width: NODE_W, height: GHOST_H }} aria-hidden="true">
                  <span className="wf-port in" />
                  <span>
                    <b>The new step lands here</b>
                    <br />
                    wired to « {adding.exit} »
                  </span>
                </div>
              )}
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
                  needsOk={props.unapproved.includes(n.id)}
                  litExits={lit ? g.edges.filter((e) => e.from === n.id && e.to === lit).map((e) => e.exit) : undefined}
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
        {adding && <AddMenu at={adding.menu} beside={NODE_W * zoom} onPick={pick} onClose={() => setAdding(null)} />}
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
  /** Its exits that lead into the selected step (lit). */
  litExits?: string[];
  /** A « Run a command » step Master has not approved yet. */
  needsOk?: boolean;
  onPointerDown?(e: ReactPointerEvent): void;
  /** Enter or Space on a focused node selects it. */
  onSelect?(): void;
  onExitDown?(e: ReactPointerEvent, exit: string): void;
  onOpenCard(id: string): void;
}) {
  const { n, g, run, phone } = props;
  const st = run ? nodeRunState(run, n.id) : null;
  const last = st?.steps.at(-1);
  const cls = ['wf-node', 'k-' + n.kind, st ? nodeClass(st.state) : '', props.selected ? 'sel' : '', props.target ? 'target' : ''].filter(Boolean).join(' ');
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
        <span className="wf-kl">{kindLine(n)}</span>
      </div>
      {props.needsOk && <span className="wf-ok-chip wf-node-ok">needs your OK</span>}
      {n.kind === 'agent' && !n.config.agentId && <span className="wf-ok-chip wf-node-ok wf-noagent-chip">no agent</span>}
      <div className="wf-title">{nodeTitle(n, g.nodes)}</div>
      <div className="wf-meta">
        {n.kind === 'agent' && n.config.agentId && <AgentFace id={n.config.agentId} />}
        <span>{nodeMeta(n, g.nodes)}</span>
      </div>
      <div className="wf-outs">
        {exitsOf(n, g.edges).map((x) => (
          <span
            key={x.exit}
            className={'wf-out' + (x.failing ? ' fail' : '') + (x.to ? ' on' : ' end') + (props.wiringExit === x.exit ? ' drag' : '') + (props.litExits?.includes(x.exit) ? ' lit' : '') + (run && !phone && takenExit(run, n.id, x.exit) ? ' taken' : '')}
            data-exit={x.exit}
            onPointerDown={props.onExitDown ? (e) => props.onExitDown!(e, x.exit) : undefined}
            title={props.onExitDown ? `${x.exit} → ${exitTarget(x, g.nodes)}. Drag onto a step to wire it, or onto empty canvas to add a step there` : undefined}
          >
            <span className="en">
              {!x.to && !phone && <span className="ends">ends · </span>}
              {x.exit}
            </span>
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
            {st.state === 'working' && <span className="step-sq" aria-hidden="true" />}
            {st.state === 'couldnt' && last?.couldntRun ? (
              <span className="wf-couldnt">Couldn't run · {last.couldntRun.autoRetry ? 'retrying' : 'waiting for you'}</span>
            ) : (
              <span className={'st-chip ' + chipClass(st.state)}>{STATE_LABEL[st.state]}</span>
            )}
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

/** « GitHub can't be read » from « GitHub can't be read: gh is logged out »: the node says the first part, the run all of it. */
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const takenExit = (run: WorkflowRun, node: string, exit: string) => (run.steps ?? []).some((s) => s.nodeId === node && s.exit === exit);

/* ── Runs: the list and the chosen run's steps ── */

function RunsPanel(props: { w: Workflow; g: Graph; runs: WorkflowRun[] | null; run: WorkflowRun | null; cards: Card[]; pick(id: string): void; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const { runs, run, g } = props;
  const [failedOnly, setFailedOnly] = useState(false);
  if (!runs) return <p className="wf-sum">Loading runs…</p>;
  if (!runs.length)
    return (
      <EmptyState title="No runs yet" />
    );
  const open = !!run && (run.state === 'running' || run.state === 'waiting');
  const listed = failedOnly ? runs.filter((r) => r.state === 'failed' || r.state === 'skipped') : runs;
  return (
    <>
      <div className="segmented wf-runfilter" role="group" aria-label="Which runs">
        <button className={!failedOnly ? 'on' : ''} aria-pressed={!failedOnly} onClick={() => setFailedOnly(false)}>
          All
        </button>
        <button className={failedOnly ? 'on' : ''} aria-pressed={failedOnly} onClick={() => setFailedOnly(true)}>
          Failed
        </button>
      </div>
      <div className="wf-runs">
        {!listed.length && <EmptyState inline title="No failed or refused run" />}
        {listed.map((r) => (
          <button key={r.id} className={r.id === run?.id ? 'on' : ''} aria-current={r.id === run?.id || undefined} onClick={() => props.pick(r.id)}>
            <span className={'st-chip ' + chipClass(r.state)}>{RUN_LABEL[r.state]}</span>
            <span className="nm">Run {r.number}</span>
            {r.subject && <span className="sj">{r.subject.prUrl ? prLabel(r.subject.prUrl) : refOf(r.subject.cardId, props.cards)}</span>}
            <span className="when">{r.state === 'running' || r.state === 'waiting' ? relative(r.startedAt).replace(' ago', '') : when(r.startedAt)}</span>
          </button>
        ))}
      </div>
      {run && (
        <div className="wf-run-detail">
          <p className="wf-h2">
            Run {run.number} · started by <RunStart run={run} cards={props.cards} onOpenCard={props.onOpenCard} /> · {open ? relative(run.startedAt) : run.endedAt ? `took ${duration(run.startedAt, run.endedAt)}` : when(run.startedAt)}
          </p>
          <ol className="wf-steps-log">
            {(run.steps ?? []).map((s) => (
              <StepLine key={s.id} s={s} g={g} cards={props.cards} onOpenCard={props.onOpenCard} />
            ))}
          </ol>
          {open && <CouldntRun run={run} g={g} cards={props.cards} onOpenCard={props.onOpenCard} onError={props.onError} />}
          {!open && run.reason && (
            <p className={'wf-sum' + (run.state === 'failed' ? ' bad' : '')}>
              <b>{RUN_LABEL[run.state]}</b>: {run.reason}
            </p>
          )}
          {run.state !== 'skipped' && <RunKnows run={run} onError={props.onError} />}
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
  const dot = st === 'couldnt' ? 'bad' : st === 'working' ? 'wk' : st === 'waiting' ? 'bk' : st === 'failed' || st === 'rejected' ? 'bad' : st === 'stopped' ? 'off' : 'ok';
  const who = n?.kind === 'agent' && n.config.agentId ? ` · @${n.config.agentId}` : '';
  const exit = s.exit && s.kind !== 'trigger' ? ` · ${s.exit}` : '';
  const round = s.round > 1 ? ` · ${ordinal(s.round)} round` : '';
  const title = s.kind === 'trigger' ? 'Trigger' : n ? nodeTitle(n, g.nodes) : `${s.nodeId} (deleted)`;
  const say =
    s.couldntRun && !s.endedAt
      ? `Couldn't run since ${hhmm(s.couldntRun.since)}: ${s.couldntRun.reason}`
      : s.state === 'running'
        ? `Working for ${duration(s.startedAt, new Date().toISOString())}`
        : s.state === 'waiting'
          ? 'Waiting for you'
          : s.summary;
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

/** An exit name's width on an edge, roughly (px at 100 %): enough to keep two names apart. */
const labelW = (exit: string) => exit.length * 7.5 + 18;
/**
 * Where an exit's name goes on a back edge's lane (#262): its middle, else the nearest free spot on either side within
 * the lane, so two edges sharing a lane show both names side by side, never on top of each other or off the canvas.
 */
function labelSpot(at: Pt, exit: string, placed: [number, number, number][], lo: number, hi: number): number {
  const w = labelW(exit);
  const free = (x: number) => !placed.some(([px, py, pw]) => Math.abs(py - at[1]) < 14 && Math.abs(px - x) < (pw + w) / 2 + 6);
  for (let d = 0; d < 600; d += 12) for (const x of [at[0] + d, at[0] - d]) if (x - w / 2 >= lo && x + w / 2 <= hi + 40 && free(x)) return x;
  return at[0];
}

/**
 * A step that couldn't run (#262, mockup « Couldn't run »): no outcome yet, the run waits on it. Retry now, or Follow its
 * negative exit; these live in the run only (the task points here).
 */
function CouldntRun({ run, g, cards, onOpenCard, onError }: { run: WorkflowRun; g: Graph; cards: Card[]; onOpenCard(id: string): void; onError(e: unknown): void }) {
  const steps = run.steps ?? [];
  const i = steps.findIndex((s) => s.couldntRun && !s.endedAt);
  const [busy, setBusy] = useState<'retry' | 'follow' | null>(null);
  const s = steps[i];
  if (!s?.couldntRun) return null;
  const c = s.couldntRun;
  const n = g.nodes.find((x) => x.id === s.nodeId);
  const task = run.subject?.cardId;
  const act = (k: 'retry' | 'follow') => {
    setBusy(k);
    (k === 'retry' ? api.retryWorkflowRun(run.id) : api.followWorkflowRun(run.id)).catch(onError).finally(() => setBusy(null));
  };
  const follow = () => {
    if (!c.negativeExit) return;
    if (confirm(`Follow « ${c.negativeExit} »? The run goes on as if « ${n ? nodeTitle(n, g.nodes) : s.nodeId} » had answered « ${c.negativeExit} ».`)) act('follow');
  };
  const notifyAt = new Date(Date.parse(c.since) + 15 * 60_000).toISOString();
  return (
    <div className="wf-couldnt-box" role="alert">
      <p>
        <b>Step {i + 1} couldn't run: no outcome yet.</b>{' '}
        {c.autoRetry ? (
          <>
            Atlas retries it by itself every minute
            {task && (
              <>
                ;{' '}
                <button className="linklike" onClick={() => onOpenCard(task)}>
                  {refOf(task, cards)}
                </button>{' '}
                stays as it is
              </>
            )}
            . {c.notified ? 'You got an Inbox item about it.' : `After 15 min of failures you get one Inbox item (at ${hhmm(notifyAt)}).`} Fix the cause and it goes on by itself.
          </>
        ) : (
          <>
            Atlas doesn't retry it by itself: Retry now
            {c.negativeExit ? `, or follow « ${c.negativeExit} »` : ''}.
          </>
        )}
      </p>
      <span className="why">{c.reason}</span>
      <div className="acts">
        <button className="primary small" disabled={!!busy} onClick={() => act('retry')}>
          {busy === 'retry' ? 'Retrying…' : 'Retry now'}
        </button>
        {c.negativeExit && (
          <button className="head-btn" disabled={!!busy} onClick={follow}>
            Follow « {c.negativeExit} »…
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The « Add step » menu (#262, mockup « Add step »): each kind says its exits. Under the header button, or at an exit's
 * drop point (`at`, stage px) beside the ghost node. It never leaves the canvas area: placed inside it, and scrolls
 * when the canvas is shorter than the menu (the approval banner takes room).
 */
function AddMenu(props: { at?: Pt; beside?: number; onPick(kind: AddKind): void; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left?: number; top?: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const stage = el?.closest('.wf-stage');
    if (!el || !stage) return;
    const area = stage.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.scrollHeight;
    if (props.at) {
      const maxHeight = Math.max(160, area.height - 16);
      const right = props.at[0] + (props.beside ?? 0) + 16;
      const x = right + w + 8 <= area.width ? right : props.at[0] - w - 16;
      const p = clampBox({ x, y: props.at[1] - 24 }, w, Math.min(h, maxHeight), { w: area.width, h: area.height });
      setBox({ left: p.x, top: p.y, maxHeight });
    } else {
      const top = el.getBoundingClientRect().top - area.top;
      setBox({ maxHeight: Math.max(160, area.height - top - 8) });
    }
  }, [props.at?.[0], props.at?.[1]]);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    const down = (e: PointerEvent) => !(e.target as HTMLElement).closest('.wf-add-menu, [aria-haspopup="menu"]') && props.onClose();
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', down);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', down);
    };
  }, []);
  return (
    <div ref={ref} className={'wf-add-menu' + (props.at ? ' at' : '')} role="menu" aria-label="Add a step" style={{ ...(box ?? {}), visibility: box ? undefined : 'hidden' }}>
      {ADD_STEPS.map((a) => (
        <button key={a.kind} role="menuitem" onClick={() => props.onPick(a.kind)}>
          <KindIcon kind={a.kind} />
          <span>
            <b>{a.label}</b>
            {a.isNew && <span className="wf-new">new</span>}
            <span className="help">{a.help}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
