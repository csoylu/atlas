import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { openDb, type Db } from './store/db.ts';
import { Bus } from './events.ts';
import { Kanban } from './kanban.ts';
import { Agents } from './agents.ts';
import { Models, realProviders, type ProviderFactory } from './models.ts';
import { Runner } from './runner.ts';
import { Rewinds } from './rewind.ts';
import { Slash } from './slash.ts';
import { FileLog } from './fileLog.ts';
import { Snapshots } from './snapshots.ts';
import { Dispatcher } from './dispatcher.ts';
import { Settings } from './settings.ts';
import { Documents } from './documents.ts';
import { workdirOf } from './agents.ts';
import { Memories } from './memory.ts';
import { MemoryCleanup } from './cleanup.ts';
import { MemoryReview } from './memoryReview.ts';
import { envWithSecrets, type SecretStore } from './secrets.ts';
import { createApi } from './api.ts';
import { Schedules } from './schedules.ts';
import { Auth, isLoopbackHost } from './auth.ts';
import { screenshotAnswer } from './screenshot.ts';
import { Local } from './local.ts';
import { Accounts } from './accounts.ts';
import { ChatGpt, type ChatGptOptions } from './chatgpt.ts';
import { ClaudePlan, type ClaudePlanOptions } from './claude-plan.ts';
import { Usage } from './usage.ts';
import { PlanAccounts } from './plan-accounts.ts';
import { Notifications } from './notifications.ts';
import { Voice, type VoiceHost } from './voice.ts';
import { VoiceChat } from './voiceChat.ts';
import { Updater, type UpdateHost } from './updater.ts';

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
  /** Turns per run before it pauses (tests lower it; default MAX_TURNS). */
  maxTurns?: number;
  /** Background memory review after runs (v3); default on. Tests with a scripted provider turn it off. */
  memoryReview?: boolean;
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
  /** App version shown in Settings → About & data (the desktop app passes its own; dev and server: package version). */
  version?: string;
  /** Desktop app on a Mac: voice mode (Settings → Voice). Absent in server mode and dev: the page is hidden. */
  voice?: VoiceHost;
  /**
   * App updates from GitHub releases (#123). The packaged Mac app passes a host (it can install); without it the
   * engine can't install and doesn't check by itself (dev, server). Tests point api/fetch at a fake release server.
   */
  updates?: { host: UpdateHost | null; cannotInstall?: string; api?: string; fetch?: typeof fetch; intervalMs?: number | false; openCommand?: string; pid?: number };
}

export interface Engine {
  db: Db;
  bus: Bus;
  kanban: Kanban;
  agents: Agents;
  runner: Runner;
  rewinds: Rewinds;
  slash: Slash;
  dispatcher: Dispatcher;
  settings: Settings;
  documents: Documents;
  memories: Memories;
  cleanup: MemoryCleanup;
  review: MemoryReview;
  models: Models;
  schedules: Schedules;
  local: Local;
  accounts: Accounts;
  chatgpt: ChatGpt;
  claude: ClaudePlan;
  plans: PlanAccounts;
  notifications: Notifications;
  usage: Usage;
  voice: Voice | null;
  /** The « Voice » chat the desktop voice loop talks through (desktop on a Mac only). */
  voiceChat: VoiceChat | null;
  updater: Updater;
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
  const notifications = new Notifications(db, bus, kanban);
  const plans = new PlanAccounts(db, bus, opts.secrets, notifications, opts.claude?.now ?? opts.chatgpt?.now);
  const chatgpt = new ChatGpt(bus, opts.secrets, plans, opts.chatgpt);
  models.setChatGpt(chatgpt);
  const claude = new ClaudePlan(bus, opts.secrets, env, plans, opts.claude);
  models.setClaude(claude);
  const usage = new Usage(db, bus);
  const memories = new Memories(db, bus);
  const schedules = new Schedules(db, bus, kanban);
  const cleanup = new MemoryCleanup(db, bus, memories);
  const settings = new Settings(db);
  const voice = opts.voice ? new Voice(db, bus, opts.voice) : null;
  let url = '';
  const voiceChat = opts.voice ? new VoiceChat(db, bus, kanban, agents, () => url) : null;
  const documents = new Documents(db, bus, kanban, (id) => workdirOf(agents.get(id), opts.dataDir));
  const fileLog = new FileLog(db, new Snapshots(join(opts.dataDir, 'checkpoints')));
  const review = new MemoryReview(db, kanban, memories, models, agents, settings, usage);
  if (opts.memoryReview === false) review.after = () => {};
  const runner = new Runner(db, bus, kanban, agents, models, memories, schedules, { fileLog, dataDir: opts.dataDir, leaseMs: opts.leaseMs, maxTurns: opts.maxTurns, usage, user: () => settings.user(), documents, cleanup, review, isVoiceChat: voiceChat ? (id) => voiceChat.isVoiceChat(id) : undefined, engine: () => ({ url, cookie: () => (auth.enabled ? auth.issue().token : null), answer: (method, path) => screenshotAnswer(kanban, method, path) }) });
  const rewinds = new Rewinds(db, bus, kanban, agents, runner, opts.dataDir, fileLog);
  const dispatcher = new Dispatcher(bus, kanban, agents, models, settings, runner);
  const slash = new Slash(db, bus, kanban, runner);
  const updater = new Updater(db, bus, {
    version: opts.version ?? 'dev',
    dataDir: opts.dataDir,
    host: opts.updates?.host ?? null,
    cannotInstall: opts.updates?.cannotInstall ?? 'Updates install by themselves in the Mac app only (this is a development build or a server).',
    backup: (file) => db.backup(file),
    api: opts.updates?.api,
    fetch: opts.updates?.fetch,
    intervalMs: opts.updates ? opts.updates.intervalMs : false,
    openCommand: opts.updates?.openCommand,
    pid: opts.updates?.pid,
  });
  const server = createApi({
    kanban,
    agents,
    models,
    runner,
    rewinds,
    slash,
    dispatcher,
    settings,
    documents,
    memories,
    cleanup,
    schedules,
    local,
    accounts,
    chatgpt,
    claude,
    plans,
    notifications,
    usage,
    voice,
    updater,
    bus,
    dataDir: opts.dataDir,
    version: opts.version ?? 'dev',
    uiDir: opts.uiDir,
    secrets: opts.secrets,
    env,
    auth,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => resolve());
  });
  // Finish a rewind a stopped engine left half done, before any run resumes and touches the files (rule 2).
  // Canvases were replaced by artifacts (#120): each one left in the archive becomes an html page, once.
  try {
    const n = documents.convertCanvases();
    if (n) console.log(`converted ${n} canvas(es) to artifacts`);
  } catch (e) {
    console.error('canvas conversion failed', e);
  }
  await rewinds.recover().catch((e: unknown) => console.error('rewind recovery failed', e));
  runner.start();
  // Watch/autostart the local server; off by default for in-memory (test) engines so they never touch a real Ollama.
  if (opts.manageLocal ?? (opts.dispatch !== false && opts.dbFile !== ':memory:')) void local.startWatching();
  if (opts.dispatch !== false) {
    dispatcher.start();
    // Built-in schedules come with the scheduler (tests without a dispatcher start from an empty list).
    cleanup.ensureSchedule(schedules, agents);
    schedules.start();
  }
  voice?.start();
  updater.start();
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
  return {
    db,
    bus,
    kanban,
    agents,
    runner,
    rewinds,
    slash,
    dispatcher,
    settings,
    documents,
    memories,
    cleanup,
    review,
    models,
    schedules,
    local,
    accounts,
    chatgpt,
    claude,
    plans,
    notifications,
    usage,
    voice,
    voiceChat,
    updater,
    url,
    stop: async () => {
      updater.stop();
      schedules.stop();
      voice?.stop();
      dispatcher.stop();
      await runner.shutdown();
      review.after = () => {};
      await review.idle; // a background memory review writes to the db: let it finish before closing
      await rewinds.shutdown();
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
export type { VoiceHost } from './voice.ts';
export type { UpdateHost } from './updater.ts';
export type { VoiceChat } from './voiceChat.ts';
export type { OrbPosition } from './settings.ts';
