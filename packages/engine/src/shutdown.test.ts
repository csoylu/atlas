import { describe, expect, it, onTestFinished } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { eventually, launch } from '../test/kit/index.ts';
import { FakeGitHub, fakeApp } from '../test/updaterKit.ts';
import { FakeProvider } from './providers/fake.ts';
import { startEngine, type Engine } from './index.ts';
import { QUIT_DONE } from './updater.ts';
import type { BrowserHost, HostEvent, HostTab } from './browser.ts';
import type { ModelRequest, ModelResponse, OnDelta, Provider } from './providers/types.ts';

/**
 * #375: the quit after Update hung at « stopping agent runs and their commands »: runner.shutdown() waited without a
 * limit for every aborted run to end. Each long tool (and the model call) must stop on the abort; whatever does not
 * is cut off after the limit, named, and resumes at the next start.
 */

const use = (name: string, input: unknown): ContentBlock[] => [{ type: 'tool_use', id: 't_' + Math.random().toString(36).slice(2, 8), name, input }];

/** A model that sends the scripted steps, then waits for the abort (a stream still going): `ignoreAbort` never ends. */
class Waiting implements Provider {
  calls = 0;
  constructor(
    private steps: ContentBlock[][],
    private o: { ignoreAbort?: boolean } = {},
  ) {}
  async complete(_req: ModelRequest, _onText: OnDelta, signal: AbortSignal): Promise<ModelResponse> {
    this.calls++;
    const step = this.steps.shift();
    if (step) return { content: step, stopReason: 'tool_use', usage: { input: 1, output: 1 } };
    if (this.o.ignoreAbort) return new Promise<never>(() => {});
    return new Promise<never>((_ok, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true }));
  }
}

/** A browser whose page never answers CDP (a modal dialog, a frozen renderer). */
class FrozenHost implements BrowserHost {
  private listeners = new Set<(e: HostEvent) => void>();
  open(t: HostTab) {
    if (!t.url || !t.load) return;
    setTimeout(() => {
      for (const l of this.listeners) l({ type: 'navigated', id: t.id, url: t.url! });
      for (const l of this.listeners) l({ type: 'loading', id: t.id, loading: false });
    }, 5);
  }
  history() {}
  close() {}
  show() {}
  setOwner() {}
  send = () => new Promise<never>(() => {});
  capture = () => new Promise<never>(() => {});
  signal() {}
  pill() {}
  flash = async () => false;
  clearData = async () => {};
  on(l: (e: HostEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}

async function start(provider: Provider, extra: Parameters<typeof launch>[0] = {}) {
  const l = await launch({ dispatch: false, env: {}, provider, ...extra });
  const card = l.engine.kanban.create({ title: 'long tool', assignee: 'atlas' }, 'user');
  l.engine.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
  l.engine.runner.wake(card.id);
  return { ...l, card };
}

const runRow = (l: Awaited<ReturnType<typeof start>>) =>
  l.engine.db.prepare('SELECT status, error FROM runs WHERE card_id = ? ORDER BY started_at DESC LIMIT 1').get(l.card.id) as { status: string; error: string | null };
const toolRunning = (l: Awaited<ReturnType<typeof start>>, name: string) =>
  eventually(() => l.engine.db.prepare("SELECT 1 FROM tool_calls WHERE name = ? AND status = 'running'").get(name), { what: `${name} to be running` });

/** Shut the runner down; returns how long it took. */
async function timedShutdown(l: Awaited<ReturnType<typeof start>>): Promise<number> {
  const t0 = Date.now();
  await l.engine.runner.shutdown();
  return Date.now() - t0;
}

describe('runner.shutdown stops every kind of long run (#375)', () => {
  it('a foreground shell command', async () => {
    const l = await start(new Waiting([use('shell', { command: 'sleep 30' })]));
    await toolRunning(l, 'shell');
    expect(await timedShutdown(l)).toBeLessThan(3000);
    expect(runRow(l)).toEqual({ status: 'interrupted', error: 'engine shutting down' });
  });

  it('a background shell command, then a model stream', async () => {
    const p = new Waiting([use('shell', { command: 'sleep 30', background: true })]);
    const l = await start(p);
    await eventually(() => p.calls === 2, { what: 'the second model call' });
    expect(await timedShutdown(l)).toBeLessThan(3000);
    expect(runRow(l).status).toBe('interrupted');
  });

  it('web_fetch of a server that never answers', async () => {
    const server = createServer(() => {});
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    onTestFinished(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const l = await start(new Waiting([use('web_fetch', { url: `http://127.0.0.1:${port}/` })]));
    await toolRunning(l, 'web_fetch');
    expect(await timedShutdown(l)).toBeLessThan(3000);
    expect(runRow(l).status).toBe('interrupted');
  });

  it('a browser tool on a page that never answers', async () => {
    const l = await start(new Waiting([use('browser_open', { url: 'http://127.0.0.1:5173/' })]), { browser: new FrozenHost() });
    await toolRunning(l, 'browser_open');
    expect(await timedShutdown(l)).toBeLessThan(3000);
    expect(runRow(l).status).toBe('interrupted');
  });
});

const mac = process.platform === 'darwin';

describe.skipIf(!mac)('the quit after Update with a run that ignores the abort (#375)', () => {
  it('goes on after the limit, names the stuck run and its tool in quit.log, and the run resumes at the next start', async () => {
    const gh = new FakeGitHub();
    await gh.listen();
    gh.publish('0.5.0');
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-375-'));
    const apps = mkdtempSync(join(tmpdir(), 'atlas-375-apps-'));
    // Atlas itself, for the helper: it waits for this pid to end, then swaps the (fake) app.
    const atlas = spawn('sleep', ['60']);
    const engines: Engine[] = [];
    onTestFinished(async () => {
      atlas.kill('SIGKILL');
      gh.server.close();
      for (const e of engines.slice(1)) await e.stop().catch(() => {});
    });
    // The tool's call never ends, abort or not (what held Master's quit for ever).
    let stopped: Promise<void> | undefined;
    const stuck = new Waiting([], { ignoreAbort: true });
    const base = { dbFile: join(dataDir, 'atlas.db'), dataDir, port: 0, dispatch: false, memoryReview: false, manageLocal: false, env: {}, sandbox: { enabled: false }, stopLimitMs: 300 };
    const e = await startEngine({
      ...base,
      providers: () => stuck,
      version: '0.4.0',
      updates: { host: { appPath: fakeApp(apps, '0.4.0'), arch: 'arm64', quit: () => void (stopped = e.stop().finally(() => atlas.kill())) }, api: gh.url, intervalMs: false, pid: atlas.pid, openCommand: 'true' },
    } as Parameters<typeof startEngine>[0]);
    engines.push(e);
    const card = e.kanban.create({ title: 'long tool', assignee: 'atlas' }, 'user');
    e.kanban.appendMessage(card.id, 'user', 'user', [{ type: 'text', text: 'go' }]);
    e.runner.wake(card.id);
    await eventually(() => stuck.calls === 1, { what: 'the model call' });
    const ref = e.kanban.ref(card.id);

    await e.updater.check();
    await e.updater.install();
    const t0 = Date.now();
    await stopped;
    expect(Date.now() - t0).toBeLessThan(5000);
    const steps = readFileSync(join(dataDir, 'update', 'quit.log'), 'utf8').trim().split('\n').map((l) => l.replace(/^\S+ /, ''));
    const i = steps.indexOf('stopping agent runs and their commands');
    expect(i).toBeGreaterThan(0);
    expect(steps[i + 1]).toMatch(new RegExp(`^agent runs still running after 0.3 s \\(left to resume at the next start\\): ${ref} @atlas \\(chat run r_\\w+\\) in its model call or between calls$`));
    expect(steps.at(-1)).toBe(QUIT_DONE);

    // The next start: the run left « running » is interrupted at once (its lease was expired) and resumed.
    const next = new FakeProvider([[{ type: 'text', text: 'resumed' }]]);
    const e2 = await startEngine({ ...base, providers: () => next } as Parameters<typeof startEngine>[0]);
    engines.push(e2);
    await eventually(() => {
      const runs = e2.db.prepare('SELECT status FROM runs WHERE card_id = ? ORDER BY started_at, rowid').all(card.id) as { status: string }[];
      return runs.map((r) => r.status).join(',') === 'interrupted,done';
    }, { what: 'the run to be resumed and done' });
    expect(e2.kanban.messages(card.id).at(-1)!.content).toEqual([{ type: 'text', text: 'resumed' }]);
  }, 20_000);

  it('a tool that ignores the abort (pr_validate on a gh that never answers): shutdown returns after the limit, naming the run and its tool', async () => {
    const hang = () => new Promise<never>(() => {});
    const p = new Waiting([use('pr_validate', { pr: 3, verdict: 'ok', sha: 'a'.repeat(40), reason: 'read it' })]);
    const l = await launch({ dispatch: false, env: {}, provider: p, stopLimitMs: 200, prs: { read: hang, intervalMs: false, validate: { gh: hang } }, projects: { clone: async (_r, dir) => void mkdirSync(dir, { recursive: true }) } });
    const e = l.engine;
    for (const id of ['zurich', 'munih']) if (!e.agents.list().some((a) => a.id === id)) e.agents.create({ id, modelId: e.agents.get('atlas').modelId });
    e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['zurich'] });
    await eventually(() => e.projects.get('datinel').members.every((m) => m.cloneState === 'ready'), { what: 'Datinel workspaces ready' });
    const c = e.kanban.create({ title: 'x', status: 'running', assignee: 'munih', projectId: 'datinel' }, 'user');
    e.kanban.requestReview(c.id, ['https://github.com/datinel/datinel/pull/3'], 'munih', 'built');
    e.db.prepare('UPDATE cards SET reviewer = ? WHERE id = ?').run('zurich', c.id);
    e.runner.wake(c.id, { agentId: 'zurich', kind: 'work', kick: 'review it' });
    await eventually(() => e.db.prepare("SELECT 1 FROM tool_calls WHERE name = 'pr_validate' AND status = 'running'").get(), { what: 'pr_validate to be running' });
    const t0 = Date.now();
    const stuck = await e.runner.shutdown(200);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(stuck).toEqual([{ runId: expect.stringMatching(/^r_/), card: e.kanban.ref(c.id), agentId: 'zurich', kind: 'work', tools: ['pr_validate'] }]);
    // Its lease is expired: the next start (or this engine's next recover) takes it over at once.
    const lease = e.db.prepare("SELECT lease_until FROM runs WHERE id = ? AND status = 'running'").get(stuck[0]!.runId) as { lease_until: string };
    expect(Date.parse(lease.lease_until)).toBeLessThanOrEqual(Date.now());
  });
});
