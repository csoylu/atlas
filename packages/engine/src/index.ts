import type { AddressInfo } from 'node:net';
import { openDb, type Db } from './store/db.ts';
import { Bus } from './events.ts';
import { Kanban } from './kanban.ts';
import { Agents } from './agents.ts';
import { Models, realProviders, type ProviderFactory } from './models.ts';
import { Runner } from './runner.ts';
import { Dispatcher } from './dispatcher.ts';
import { Settings } from './settings.ts';
import { Canvases } from './canvas.ts';
import { Memories } from './memory.ts';
import { envWithSecrets, type SecretStore } from './secrets.ts';
import { createApi } from './api.ts';
import { Schedules } from './schedules.ts';
import { Auth, isLoopbackHost } from './auth.ts';
import { Local } from './local.ts';
import { Accounts } from './accounts.ts';
import { ChatGpt, type ChatGptOptions } from './chatgpt.ts';
import { ClaudePlan, type ClaudePlanOptions } from './claude-plan.ts';
import { Usage } from './usage.ts';

export interface EngineOptions {
  /** SQLite file, or ':memory:'. */
  dbFile: string;
  /** Where agent workspaces live by default. */
  dataDir: string;
  port: number;
  host?: string;
  /** Built UI to serve (server/desktop mode). */
  uiDir?: string;
  /** Tests inject a fake provider here. */
  providers?: ProviderFactory;
  env?: NodeJS.ProcessEnv;
  /** Run lease length (tests shorten it). */
  leaseMs?: number;
  /** Start the dispatcher (default true). Runner-only tests turn it off. */
  dispatch?: boolean;
  /** Desktop: keys kept in the OS keychain, editable from Settings. */
  secrets?: SecretStore;
  /** Local model server options (tests pass binary: null and a fake fetch; manageLocal: false skips the watcher). */
  local?: { url?: string; binary?: string | null; fetch?: typeof fetch };
  manageLocal?: boolean;
  /** ChatGPT sign-in endpoints and callback port (tests point them at a fake OpenAI). */
  chatgpt?: ChatGptOptions;
  claude?: ClaudePlanOptions;
  /**
   * Server mode (design §12): the login password (env ATLAS_PASSWORD). Without it the engine has no login and only
   * answers on a loopback host; it refuses to listen elsewhere.
   */
  password?: string | null;
}

export interface Engine {
  db: Db;
  bus: Bus;
  kanban: Kanban;
  agents: Agents;
  runner: Runner;
  dispatcher: Dispatcher;
  settings: Settings;
  canvases: Canvases;
  memories: Memories;
  models: Models;
  schedules: Schedules;
  local: Local;
  accounts: Accounts;
  chatgpt: ChatGpt;
  claude: ClaudePlan;
  usage: Usage;
  url: string;
  stop(): Promise<void>;
}

export async function startEngine(opts: EngineOptions): Promise<Engine> {
  const host = opts.host ?? '127.0.0.1';
  const auth = new Auth(opts.password || null);
  if (!auth.enabled && !isLoopbackHost(host.includes(':') ? `[${host}]` : host))
    throw new Error(`refusing to listen on ${host} without a password: set ATLAS_PASSWORD, or listen on 127.0.0.1 behind a proxy`);
  const db = openDb(opts.dbFile);
  const bus = new Bus();
  const kanban = new Kanban(db, bus);
  const agents = new Agents(db);
  const env = envWithSecrets(opts.env ?? process.env, opts.secrets);
  const models = new Models(db, opts.providers ?? realProviders, env);
  const local = new Local(db, bus, { dataDir: opts.dataDir, url: opts.local?.url ?? env.ATLAS_OLLAMA_URL, binary: opts.local?.binary, fetch: opts.local?.fetch });
  models.setLocal(local);
  const accounts = new Accounts(db, env, opts.secrets);
  models.setAccounts(accounts);
  const chatgpt = new ChatGpt(db, bus, opts.secrets, opts.chatgpt);
  models.setChatGpt(chatgpt);
  const claude = new ClaudePlan(db, bus, opts.secrets, env, opts.claude);
  models.setClaude(claude);
  const usage = new Usage(db, bus);
  const canvases = new Canvases(db, bus);
  const memories = new Memories(db);
  const schedules = new Schedules(db, bus, kanban);
  const runner = new Runner(db, bus, kanban, agents, models, canvases, memories, schedules, { dataDir: opts.dataDir, leaseMs: opts.leaseMs, usage });
  const settings = new Settings(db);
  const dispatcher = new Dispatcher(bus, kanban, agents, models, settings, runner);
  const server = createApi({
    kanban,
    agents,
    models,
    runner,
    dispatcher,
    settings,
    canvases,
    memories,
    schedules,
    local,
    accounts,
    chatgpt,
    claude,
    usage,
    bus,
    dataDir: opts.dataDir,
    uiDir: opts.uiDir,
    secrets: opts.secrets,
    env,
    auth,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve());
  });
  runner.start();
  // Watch/autostart the local server; off by default for in-memory (test) engines so they never touch a real Ollama.
  if (opts.manageLocal ?? (opts.dispatch !== false && opts.dbFile !== ':memory:')) void local.startWatching();
  if (opts.dispatch !== false) {
    dispatcher.start();
    schedules.start();
  }
  const { port } = server.address() as AddressInfo;
  return {
    db,
    bus,
    kanban,
    agents,
    runner,
    dispatcher,
    settings,
    canvases,
    memories,
    models,
    schedules,
    local,
    accounts,
    chatgpt,
    claude,
    usage,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      schedules.stop();
      dispatcher.stop();
      await runner.shutdown();
      await local.shutdown();
      chatgpt.stop();
      claude.stop();
      await new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      });
      db.close();
    },
  };
}

export { Kanban } from './kanban.ts';
export { openDb } from './store/db.ts';
export type { SecretStore } from './secrets.ts';
