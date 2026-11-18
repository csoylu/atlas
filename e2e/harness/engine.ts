import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startEngine, type Engine, type EngineOptions } from '../../packages/engine/src/index.ts';
import type { Card, ClearEvent, Timeline } from '@atlas/shared';
import { Scripted } from './scripted.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const json = { 'content-type': 'application/json' };

/** A throwaway Atlas: real engine + SQLite file + the built UI, with a scripted model. */
export class TestAtlas {
  /** What start() was given beyond the data dir and model: a restart reuses it unless overridden. */
  opts: { version?: string; updates?: EngineOptions['updates']; prs?: EngineOptions['prs'] } = {};
  private constructor(
    public engine: Engine,
    public model: Scripted,
    public dataDir: string,
  ) {}

  static async start(o: { dataDir?: string; model?: Scripted; version?: string; updates?: EngineOptions['updates']; prs?: EngineOptions['prs'] } = {}): Promise<TestAtlas> {
    const model = o.model ?? new Scripted();
    const dataDir = o.dataDir ?? mkdtempSync(join(tmpdir(), 'atlas-e2e-'));
    mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
    const engine = await startEngine({
      dbFile: join(dataDir, 'atlas.db'),
      dataDir,
      port: 0,
      uiDir: join(root, 'packages', 'ui', 'dist'),
      providers: () => model,
      manageLocal: false,
      memoryReview: false,
      ...(o.version ? { version: o.version } : {}),
      ...(o.updates ? { updates: o.updates } : {}),
      // Never the real GitHub: a test that links PRs passes its own reader (#189).
      prs: o.prs ?? { read: async () => { throw new Error('no GitHub in e2e'); }, intervalMs: false },
    });
    // Past the first-run welcome sheet (it would cover the UI).
    await fetch(engine.url + '/api/settings', { method: 'PATCH', headers: json, body: JSON.stringify({ userName: 'Tester', userAbout: 'QA engineer running the Atlas end-to-end tests.' }) });
    const a = new TestAtlas(engine, model, dataDir);
    a.opts = { version: o.version, updates: o.updates, prs: o.prs };
    return a;
  }

  get url(): string {
    return this.engine.url;
  }
  private get api(): string {
    return this.engine.url + '/api';
  }

  /** Stop the engine and start a new one on the same data (a crash-safe restart). The port changes. */
  async restart(o: { version?: string; updates?: EngineOptions['updates']; prs?: EngineOptions['prs'] } = {}): Promise<void> {
    await this.engine.stop().catch(() => {});
    const opts = { ...this.opts, ...o };
    this.engine = (await TestAtlas.start({ dataDir: this.dataDir, model: this.model, ...opts })).engine;
    this.opts = opts;
  }
  async stop(o: { keepData?: boolean } = {}): Promise<void> {
    await this.engine.stop().catch(() => {});
    if (!o.keepData) rmSync(this.dataDir, { recursive: true, force: true });
  }

  async chat(agent = 'atlas'): Promise<Card> {
    return (await (await fetch(this.api + `/agents/${agent}/chats`, { method: 'POST' })).json()) as Card;
  }
  /** A task assigned to the agent, put to work. The scripted model decides how the run ends (a plain text reply blocks the task with that question). */
  async task(title: string, agent = 'atlas'): Promise<Card> {
    const r = await fetch(this.api + '/cards', { method: 'POST', headers: json, body: JSON.stringify({ title, body: 'E2E task', status: 'ready', assignee: agent }) });
    return (await r.json()) as Card;
  }
  async say(cardId: string, text: string): Promise<void> {
    const r = await fetch(this.api + `/cards/${cardId}/messages`, { method: 'POST', headers: json, body: JSON.stringify({ text }) });
    if (r.status !== 201) throw new Error(`say: ${r.status} ${await r.text()}`);
  }
  async command(cardId: string, command: 'clear' | 'compact', arg?: string): Promise<Response> {
    return fetch(this.api + `/cards/${cardId}/command`, { method: 'POST', headers: json, body: JSON.stringify(arg ? { command, arg } : { command }) });
  }
  async timeline(cardId: string): Promise<Timeline> {
    return (await (await fetch(this.api + `/cards/${cardId}/timeline`)).json()) as Timeline;
  }
  async clears(cardId: string): Promise<ClearEvent[]> {
    return (await this.timeline(cardId)).clears ?? [];
  }
  async card(cardId: string): Promise<Card> {
    return (await (await fetch(this.api + `/cards/${cardId}`)).json()) as Card;
  }
  async messages(cardId: string): Promise<{ seq: number; author: string; role: string }[]> {
    return (await (await fetch(this.api + `/cards/${cardId}/messages`)).json()) as never;
  }
  /** Wait until no run is going on the card. */
  async idle(cardId: string, timeout = 15_000): Promise<void> {
    const end = Date.now() + timeout;
    while (this.engine.runner.current(cardId)) {
      if (Date.now() > end) throw new Error('run still going on ' + cardId);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  /** Seed history through the API: `n` user messages, each answered by the scripted model. */
  async converse(cardId: string, ...texts: string[]): Promise<void> {
    for (const t of texts) {
      const before = this.model.of('main').length;
      await this.say(cardId, t);
      const end = Date.now() + 15_000;
      while (this.model.of('main').length === before && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
      await this.idle(cardId);
    }
  }
  run(cardId: string) {
    return this.engine.runner.runs(cardId)[0];
  }
  db(sql: string, ...args: unknown[]): unknown {
    return this.engine.db.prepare(sql).all(...(args as never[]));
  }
}
