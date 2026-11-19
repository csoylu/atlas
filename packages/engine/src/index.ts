import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { openDb, type Db } from './store/db.ts';
import { Bus } from './events.ts';
import { Kanban } from './kanban.ts';
import { Agents } from './agents.ts';
import { Models, realProviders, type ProviderFactory } from './models.ts';
import { Runner, type RunnerOptions } from './runner.ts';
import { SideEffects } from './sideEffects.ts';
import { Rewinds } from './rewind.ts';
import { Slash } from './slash.ts';
import { FileLog } from './fileLog.ts';
import { Snapshots } from './snapshots.ts';
import { Dispatcher } from './dispatcher.ts';
import { Settings } from './settings.ts';
import { Documents } from './documents.ts';
import { Memories } from './memory.ts';
import { MemoryCleanup } from './cleanup.ts';
import { MemoryReview } from './memoryReview.ts';
import { envWithSecrets, Secrets, type SecretStore } from './secrets.ts';
import { createApi } from './api.ts';
import { Workflows } from './workflows.ts';
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
import { ShellEnv, type ShellPathOptions } from './shellEnv.ts';
import { Prs, ghReader, type GhRead, type PrSync } from './prs.ts';
import { findClone, syncBranch } from './prSync.ts';
import { Projects, ghClone, ghRunner, workspaceOf, type CloneRun, type GhRun } from './projects.ts';
import { Stalls } from './stalls.ts';

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
  /** Safety ceiling: turns per run before it stops (tests lower it; default MAX_TURNS, loopGuard.ts). */
  maxTurns?: number;
  /** Background memory review after runs (v3); default on. Tests with a scripted provider turn it off. */
  memoryReview?: boolean;
  /** The stall checker's clock (#237 tests). */
  stallsNow?: () => number;
  /** Start the dispatcher (default true). Runner-only tests turn it off. */
  dispatch?: boolean;
  /**
   * Desktop: keys kept in the OS keychain, editable from Settings. Server (main.ts): secrets.enc, locked until its
   * password is given (secretFile.ts); plan sign-ins stay desktop-only there.
   */
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
   * PATH of agent shells (#136): 'login' reads the user's login shell once at start (desktop app, local dev);
   * 'engine' keeps the engine's own (server mode; default, so tests never run a login shell). Tests pass options
   * (a fake login shell).
   */
  shellPath?: 'login' | 'engine' | ShellPathOptions;
  /** Pull requests of tasks In review (#189): how they are read (default: gh api) and how often (false: never by itself). */
  prs?: { read?: GhRead; sync?: PrSync; intervalMs?: number | false; validate?: RunnerOptions['prTool'] };
  /**
   * Projects (#213): how the repo check runs gh (default: gh with the engine's login-shell env); how a member's
   * workspace is cloned (#214, default: gh repo clone, same env).
   */
  projects?: { gh?: GhRun; clone?: CloneRun };
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
  workflows: Workflows;
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
  prs: Prs;
  stalls: Stalls;
  secrets: Secrets;
  projects: Projects;
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
  // Plan sign-ins (ChatGPT, Claude) need the keychain: a server's password store doesn't take them (#208).
  const planStore = opts.secrets?.lock ? undefined : opts.secrets;
  const plans = new PlanAccounts(db, bus, planStore, notifications, opts.claude?.now ?? opts.chatgpt?.now);
  const chatgpt = new ChatGpt(bus, planStore, plans, opts.chatgpt);
  models.setChatGpt(chatgpt);
  const claude = new ClaudePlan(bus, planStore, env, plans, opts.claude);
  models.setClaude(claude);
  const usage = new Usage(db, bus);
  const memories = new Memories(db, bus);
  const workflows = new Workflows(db, bus, kanban);
  const cleanup = new MemoryCleanup(db, bus, memories);
  const settings = new Settings(db);
  const secrets = new Secrets(db, bus, opts.secrets, env, opts.env ?? process.env, kanban);
  secrets.sync();
  models.setLockedNames(() => secrets.lockedNames());
  secrets.resume(); // a value added just before a crash: its waiting task goes back to work (#207)
  const shellEnv = new ShellEnv(typeof opts.shellPath === 'object' ? opts.shellPath : { mode: opts.shellPath ?? 'engine' });
  const projects = new Projects(db, bus, opts.projects?.gh ?? ghRunner(() => shellEnv.engineEnv()), kanban, {
    dataDir: opts.dataDir,
    clone: opts.projects?.clone ?? ghClone(),
    env: () => shellEnv.engineEnv(),
  });
  const voice = opts.voice ? new Voice(db, bus, opts.voice) : null;
  let url = '';
  const voiceChat = opts.voice ? new VoiceChat(db, bus, kanban, agents, () => url) : null;
  const documents = new Documents(db, bus, kanban, opts.dataDir, secrets);
  // Secret values out of stored artifact versions (#226): those stored before the value was known, at each start and
  // after each value change. A failure is logged and the pass runs again at the next start.
  const redactStored = () => {
    const n = documents.redactStored();
    if (n) console.log(`hid secret values in ${n} stored artifact row(s)`);
  };
  try {
    redactStored();
  } catch (e) {
    console.error('redacting stored artifact versions failed (retried at the next start)', e);
  }
  secrets.onValues(redactStored);
  const fileLog = new FileLog(db, new Snapshots(join(opts.dataDir, 'checkpoints')));
  const review = new MemoryReview(db, kanban, memories, models, agents, settings, usage);
  if (opts.memoryReview === false) review.after = () => {};
  const effects = new SideEffects(db, kanban, memories, workflows);
  const runner = new Runner(db, bus, kanban, agents, models, memories, workflows, { fileLog, effects, dataDir: opts.dataDir, leaseMs: opts.leaseMs, maxTurns: opts.maxTurns, usage, user: () => settings.user(), documents, cleanup, review, isVoiceChat: voiceChat ? (id) => voiceChat.isVoiceChat(id) : undefined, engine: () => ({ url, cookie: () => (auth.enabled ? auth.issue().token : null), answer: (method, path) => screenshotAnswer(kanban, method, path) }), shellEnv, secrets, prTool: opts.prs?.validate });
  const rewinds = new Rewinds(db, bus, kanban, agents, runner, opts.dataDir, fileLog, effects);
  const dispatcher = new Dispatcher(bus, kanban, agents, models, settings, runner);
  const slash = new Slash(db, bus, kanban, runner);
  const prs = new Prs(db, bus, kanban, agents, runner, {
    read: opts.prs?.read ?? ghReader(() => shellEnv.engineEnv()),
    // The merge queue's rebase (#236): in the reviewer's clone of the repo in its workspace for the project, with the
    // engine's environment (login PATH; the commits keep their authors, the committer is the user's git identity).
    sync:
      opts.prs?.sync ??
      (async (a) => {
        const env = await shellEnv.engineEnv();
        const clone = await findClone(workspaceOf(db, opts.dataDir, a.reviewer, a.projectId), a.repo, env);
        return syncBranch({ clone, branch: a.branch, sha: a.sha, base: a.base, env });
      }),
    intervalMs: opts.prs?.intervalMs,
  });
  dispatcher.reviewReason = (c) => prs.reason(c);
  dispatcher.recheck = (id) => prs.recheck(id);
  // Stuck tasks (#237): looked at on the dispatcher's tick.
  const stalls = new Stalls(db, bus, kanban, runner, opts.stallsNow);
  stalls.startProblem = (c) => dispatcher.startProblem(c);
  stalls.reviewStall = (c) => prs.reviewStall(c);
  stalls.reviewQueue = (c) => prs.queueSpot(c);
  stalls.deliver = (id) => dispatcher.onAgentMessage(id);
  dispatcher.stalls = stalls;
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
    workflows,
    local,
    accounts,
    chatgpt,
    claude,
    plans,
    notifications,
    usage,
    voice,
    updater,
    shellEnv,
    bus,
    dataDir: opts.dataDir,
    version: opts.version ?? 'dev',
    uiDir: opts.uiDir,
    secrets,
    env,
    auth,
    projects,
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
  // A removed member's runs in that project stop (#214); clones a stopped engine left half done start again.
  projects.onRelease = (ids, why) => {
    for (const id of ids) runner.stop(id, why);
  };
  projects.resume();
  // Watch/autostart the local server; off by default for in-memory (test) engines so they never touch a real Ollama.
  if (opts.manageLocal ?? (opts.dispatch !== false && opts.dbFile !== ':memory:')) void local.startWatching();
  if (opts.dispatch !== false) {
    dispatcher.start();
    // Built-in workflows come with the trigger clock (tests without a dispatcher start from an empty list).
    cleanup.ensureSchedule(workflows, agents);
    workflows.start();
    prs.start();
  }
  voice?.start();
  updater.start();
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}`;
  return {
    db,
    secrets,
    projects,
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
    workflows,
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
    prs,
    stalls,
    url,
    stop: async () => {
      prs.stop();
      updater.stop();
      workflows.stop();
      voice?.stop();
      dispatcher.stop();
      await prs.idle();
      await projects.stop();
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
