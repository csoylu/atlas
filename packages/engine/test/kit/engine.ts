import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { Card } from '@atlas/shared';
import { startEngine, type Engine } from '../../src/index.ts';
import { FakeProvider } from '../../src/providers/fake.ts';
import { eventually } from './wait.ts';
import { reviewGraph, reviewWorkflowOf } from '../../src/reviewFlow.ts';
import type { Provider } from '../../src/providers/types.ts';

type EngineOptions = Parameters<typeof startEngine>[0];
type Script = ConstructorParameters<typeof FakeProvider>[0];

export interface LaunchOptions extends Partial<EngineOptions> {
  /** A model script for the fake provider (or pass `provider`). */
  script?: Script;
  /** Any Provider: the injected model. */
  provider?: Provider;
}

const json = { 'content-type': 'application/json' };
/** Tests never reach GitHub: a project repo is cloned only with an injected `projects.clone` (#214). */
const noClone = async () => {
  throw new Error('no clone in this test: pass projects.clone');
};

/**
 * A throwaway engine, every dependency injectable: the model (`script` or `provider`), and anything startEngine takes
 * (`updates.fetch`, `dispatch`, `leaseMs`, a `dbFile` to restart on…). Defaults make a test fast and isolated: in-memory
 * SQLite, a temp data dir, port 0, no local model manager, no memory review. It stops itself when the test ends
 * (onTestFinished), so there is no afterEach to forget.
 * The agent command sandbox is off unless the test asks for it (`sandbox: { enabled: true }`): tests run inside an
 * agent's own sandbox, where a nested one cannot start (#316). The sandbox has its own tests.
 */
export async function launch(o: LaunchOptions = {}) {
  const { script, provider, ...rest } = o;
  const fake = provider ?? new FakeProvider(script ?? []);
  const ownDir = !rest.dataDir;
  const dataDir = rest.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-t-'));
  mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
  const engine: Engine = await startEngine({ dbFile: ':memory:', port: 0, manageLocal: false, memoryReview: false, providers: () => fake, ...rest, sandbox: { enabled: false, ...rest.sandbox }, projects: { clone: noClone, ...rest.projects }, dataDir } as EngineOptions);
  onTestFinished(async () => {
    await engine.stop().catch(() => {});
    if (ownDir) rmSync(dataDir, { recursive: true, force: true });
  });
  const api = engine.url + '/api';
  // With a password (server mode), calls carry the session of one login.
  let session: Record<string, string> = {};
  if (rest.password) {
    const r = await fetch(api + '/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ password: rest.password }) });
    session = { cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  }
  /** Plain JSON call; returns status and parsed body. */
  const call = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const r = await fetch(api + path, { method, headers: { ...json, ...session }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
  };
  return {
    engine,
    provider: fake as Provider,
    /** The scripted provider when launched with `script`. */
    fake: fake as FakeProvider,
    dataDir,
    workdir: join(dataDir, 'workspaces', 'atlas'),
    api,
    call,
    chat: async (agent = 'atlas') => (await call<Card>('POST', `/agents/${agent}/chats`)).body,
    say: async (cardId: string, text: string) => {
      const r = await call('POST', `/cards/${cardId}/messages`, { text });
      if (r.status !== 201) throw new Error(`say: ${r.status} ${JSON.stringify(r.body)}`);
    },
    /** Resolves once no run is active on the card. */
    idle: (cardId: string, timeout = 8000) => eventually(() => engine.runner.current(cardId) === null, { timeout, what: `the run on ${cardId} to end` }),
  };
}
export type Launched = Awaited<ReturnType<typeof launch>>;

/**
 * Choose who reviews in `projectId`'s Review workflow (#334, as Master does in its steps): `reviewer` in « Review the PR »
 * and in « Built by another agent? », `other` (default: the project's lead) in « Review the reviewer's PR ». Each is
 * added as a member if needed (the default project: its own workspace, no clone). Makes the workflow if missing.
 */
export function setReviewers(engine: Engine, projectId: string, reviewer: string | null, other?: string | null): void {
  const p = engine.projects.get(projectId);
  const second = other === undefined ? p.lead : other;
  const members = p.members.map((m) => m.agentId);
  const add = [reviewer, second].filter((a): a is string => !!a && !members.includes(a));
  if (add.length) engine.projects.update(p.id, { members: [...members, ...new Set(add)] });
  const id = reviewWorkflowOf(engine.db, p.id)?.id ?? engine.workflows.createReview(p.id);
  engine.db.prepare('UPDATE projects SET review_seeded = 1 WHERE id = ?').run(p.id);
  const w = engine.workflows.get(id);
  const g = reviewGraph({ reviewer, other: second });
  engine.workflows.saveGraph(id, { revision: w.revision, nodes: g.nodes, edges: g.edges }, 'user');
}
