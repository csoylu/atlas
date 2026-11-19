import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { Card } from '@atlas/shared';
import { startEngine, type Engine } from '../../src/index.ts';
import { FakeProvider } from '../../src/providers/fake.ts';
import { eventually } from './wait.ts';
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
 */
export async function launch(o: LaunchOptions = {}) {
  const { script, provider, ...rest } = o;
  const fake = provider ?? new FakeProvider(script ?? []);
  const ownDir = !rest.dataDir;
  const dataDir = rest.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-t-'));
  mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
  const engine: Engine = await startEngine({ dbFile: ':memory:', port: 0, manageLocal: false, memoryReview: false, providers: () => fake, ...rest, projects: { clone: noClone, ...rest.projects }, dataDir } as EngineOptions);
  onTestFinished(async () => {
    await engine.stop().catch(() => {});
    if (ownDir) rmSync(dataDir, { recursive: true, force: true });
  });
  const api = engine.url + '/api';
  /** Plain JSON call; returns status and parsed body. */
  const call = async <T = unknown>(method: string, path: string, body?: unknown) => {
    const r = await fetch(api + path, { method, headers: json, body: body === undefined ? undefined : JSON.stringify(body) });
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
 * Make `agentId` the review agent of `projectId` (#263, Settings → Projects), adding it as a member if needed. In the
 * default project a new member works in its own workspace: no clone.
 */
export function setReviewAgent(engine: Engine, projectId: string, agentId: string): void {
  const p = engine.projects.get(projectId);
  const members = p.members.map((m) => m.agentId);
  engine.projects.update(p.id, { ...(members.includes(agentId) ? {} : { members: [...members, agentId] }), reviewAgent: agentId });
}
