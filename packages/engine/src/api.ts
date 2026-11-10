import express, { type ErrorRequestHandler } from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { ZodError } from 'zod';
import { isTimeZone, PostMessage, ScheduleWhen } from '@atlas/shared';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Runner } from './runner.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { Settings } from './settings.ts';
import type { Memories } from './memory.ts';
import { localTimeZone, upcoming, type Schedules } from './schedules.ts';
import { TOKEN_ENTRIES, SECRET_NAME, type SecretStore } from './secrets.ts';
import { StaleVersionError, type Canvases } from './canvas.ts';
import { workdirOf } from './agents.ts';
import { inside } from './tools.ts';
import { statSync } from 'node:fs';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import type { Bus } from './events.ts';
import type { Local } from './local.ts';
import type { Accounts } from './accounts.ts';
import type { ChatGpt } from './chatgpt.ts';
import type { ClaudePlan } from './claude-plan.ts';
import type { Usage } from './usage.ts';
import { DEFAULT_CONTEXT_WINDOW } from '@atlas/shared';

/** Who the UI acts as. One user (design §1). */
const USER = 'can';

import { Auth, SESSION_COOKIE } from './auth.ts';

export function createApi(deps: {
  kanban: Kanban;
  agents: Agents;
  models: Models;
  runner: Runner;
  dispatcher: Dispatcher;
  settings: Settings;
  canvases: Canvases;
  memories: Memories;
  schedules: Schedules;
  local: Local;
  accounts: Accounts;
  chatgpt: ChatGpt;
  claude: ClaudePlan;
  usage: Usage;
  bus: Bus;
  dataDir: string;
  uiDir?: string;
  secrets?: SecretStore;
  env: NodeJS.ProcessEnv;
  /** Login and cross-site checks (auth.ts). */
  auth: Auth;
}): Server {
  const { kanban, agents, models, runner, dispatcher, settings, canvases, memories, schedules, local, accounts, chatgpt, claude, usage, bus, auth } = deps;
  const app = express();
  // Behind Caddy on the same machine: trust its X-Forwarded-Proto so session cookies get the Secure flag over HTTPS.
  app.set('trust proxy', 'loopback');
  app.disable('x-powered-by');
  // Refuse cross-site browser requests before anything else (auth.ts: localhost is reachable from any web page).
  app.use((req, res, next) => {
    const why = auth.crossSite(req);
    if (why) return void res.status(403).json({ error: why });
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  // ── Health is always public ──────────────────────────────────────────
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // ── Login (public) ───────────────────────────────────────────────────
  app.post('/api/auth/check', (req, res) => {
    res.json({ authenticated: auth.authenticated(req), enabled: auth.enabled });
  });
  app.post('/api/auth/login', (req, res) => {
    const r = auth.login((req.body as { password?: unknown } | undefined)?.password, req.ip ?? 'unknown');
    if (!r.ok) return void res.status(r.status).json({ error: r.error });
    const { token, maxAgeMs } = auth.issue();
    res.cookie(SESSION_COOKIE, token, auth.cookieOptions(req, maxAgeMs));
    res.json({ ok: true });
  });
  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(SESSION_COOKIE, { ...auth.cookieOptions(req, 0), maxAge: undefined });
    res.json({ ok: true });
  });

  // Everything else under /api needs a session in server mode. The built UI itself is public (it shows the login).
  app.use('/api', (req, res, next) => {
    if (!auth.authenticated(req)) return void res.status(401).json({ error: 'log in first' });
    next();
  });

  // ── Protected API routes ────────────────────────────────────────────

  app.get('/api/cards', (_req, res) => {
    res.json(kanban.list());
  });
  app.post('/api/cards', (req, res) => {
    res.status(201).json(kanban.create(req.body, USER));
  });
  app.get('/api/cards/:id', (req, res) => {
    res.json(kanban.get(req.params.id));
  });
  app.patch('/api/cards/:id', (req, res) => {
    res.json(kanban.update(req.params.id, req.body, USER)); // the dispatcher reacts to the change
  });
  app.delete('/api/cards/:id', (req, res) => {
    kanban.remove(req.params.id);
    res.status(204).end();
  });
  app.get('/api/cards/:id/messages', (req, res) => {
    res.json(kanban.messages(req.params.id));
  });
  app.post('/api/cards/:id/messages', (req, res) => {
    const { text } = PostMessage.parse(req.body);
    const message = kanban.appendMessage(req.params.id, 'user', USER, [{ type: 'text', text }]);
    dispatcher.onUserMessage(req.params.id); // unblocks, resumes review, or gets a chat reply
    res.status(201).json(message);
  });
  app.get('/api/cards/:id/runs', (req, res) => {
    kanban.get(req.params.id);
    res.json(runner.runs(req.params.id));
  });
  app.post('/api/cards/:id/retry', async (req, res) => {
    await dispatcher.retry(req.params.id);
    res.json(kanban.get(req.params.id));
  });
  app.post('/api/cards/:id/stop', (req, res) => {
    res.json({ stopped: runner.stop(req.params.id) });
  });

  /** Direct chats (Kanban.newChat), latest first; the card id is used with the card message/stop/retry/delete routes. */
  app.get('/api/chats', (_req, res) => {
    res.json(kanban.directs());
  });
  app.post('/api/agents/:id/chats', (req, res) => {
    if (!agents.list().some((a) => a.id === req.params.id)) throw new NotFoundError(`agent ${req.params.id} not found`);
    res.status(201).json(kanban.newChat(req.params.id));
  });
  app.get('/api/agents', (_req, res) => {
    res.json(agents.list());
  });
  app.post('/api/agents', (req, res) => {
    res.status(201).json(agents.create(req.body));
  });
  app.patch('/api/agents/:id', (req, res) => {
    res.json(agents.update(req.params.id, req.body));
    dispatcher.tick(); // a new model or slot count may unblock cards
  });
  app.delete('/api/agents/:id', (req, res) => {
    agents.remove(req.params.id);
    res.status(204).end();
  });
  app.get('/api/memory/:agent', (req, res) => {
    if (req.params.agent !== 'shared') agents.get(req.params.agent);
    res.json(memories.get(req.params.agent));
  });
  app.put('/api/memory/:agent', (req, res) => {
    if (req.params.agent !== 'shared') agents.get(req.params.agent);
    res.json(memories.set(req.params.agent, String((req.body as { text?: unknown }).text ?? ''), USER));
  });
  app.get('/api/models', (_req, res) => {
    res.json(models.list());
  });
  app.post('/api/models', (req, res) => {
    res.status(201).json(models.create(req.body));
  });
  app.patch('/api/models/:id', (req, res) => {
    res.json(models.update(req.params.id, req.body));
  });
  app.delete('/api/models/:id', (req, res) => {
    models.remove(req.params.id);
    res.status(204).end();
  });
  app.post('/api/models/:id/test', async (req, res) => {
    const result = await models.test(req.params.id);
    dispatcher.tick(); // a model that answers again unblocks its cards
    res.json(result);
  });
  app.get('/api/canvases', (_req, res) => {
    res.json(canvases.list());
  });
  app.post('/api/canvases', (req, res) => {
    res.status(201).json(canvases.create(req.body, USER));
  });
  app.get('/api/canvases/:id', (req, res) => {
    res.json(canvases.get(req.params.id));
  });
  app.put('/api/canvases/:id', (req, res) => {
    res.json(canvases.save(req.params.id, req.body, USER));
  });
  app.patch('/api/canvases/:id', (req, res) => {
    res.json(canvases.rename(req.params.id, String((req.body as { name?: unknown }).name ?? ''), USER));
  });
  app.delete('/api/canvases/:id', (req, res) => {
    canvases.remove(req.params.id);
    res.status(204).end();
  });
  app.get('/api/canvases/:id/versions', (req, res) => {
    res.json(canvases.versions(req.params.id));
  });
  app.post('/api/canvases/:id/restore/:version', (req, res) => {
    res.json(canvases.restore(req.params.id, Number(req.params.version), USER));
  });

  // Files in an agent's workspace, for url nodes (built apps, pages, images). Served with a CSP sandbox so a page
  // never runs with the app's origin, even if opened directly in a tab.
  app.get('/api/files/:agent/{*path}', (req, res, next) => {
    const agent = agents.get(req.params.agent);
    const root = workdirOf(agent, deps.dataDir);
    const rel = ((req.params as { path?: string[] }).path ?? []).join('/');
    let file = inside(root, rel || '.');
    try {
      if (statSync(file).isDirectory()) file = inside(root, (rel ? rel + '/' : '') + 'index.html');
    } catch {
      return void res.status(404).json({ error: `no file ${rel} in ${agent.id}'s workspace` });
    }
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals');
    res.sendFile(file, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // Model keys. Names and presence only; values go in, never out.
  app.get('/api/secrets', (_req, res) => {
    res.json({ store: deps.secrets?.label ?? null, names: (deps.secrets?.names() ?? []).filter((n) => !TOKEN_ENTRIES.has(n)) });
  });
  app.put('/api/secrets/:name', (req, res) => {
    const name = req.params.name;
    if (!deps.secrets) throw new ConflictError(`this engine reads keys from its environment: set ${name} there and restart it`);
    if (!SECRET_NAME.test(name)) throw new ConflictError(`${name} is not a valid variable name (A-Z, 0-9, _)`);
    if (TOKEN_ENTRIES.has(name)) throw new ConflictError(`${name} belongs to a sign-in (ChatGPT or Claude plan)`);
    const value = String((req.body as { value?: unknown }).value ?? '').trim();
    if (!value) throw new ConflictError('the value is empty');
    deps.secrets.set(name, value);
    deps.env[name] = value;
    if (name.startsWith('ATLAS_CLAUDE_')) claude.notify();
    res.status(204).end();
    dispatcher.tick();
  });
  app.delete('/api/secrets/:name', (req, res) => {
    if (!deps.secrets) throw new ConflictError('this engine reads keys from its environment');
    if (TOKEN_ENTRIES.has(req.params.name)) throw new ConflictError('sign out instead (Models page)');
    deps.secrets.delete(req.params.name);
    delete deps.env[req.params.name];
    if (req.params.name.startsWith('ATLAS_CLAUDE_')) claude.notify();
    res.status(204).end();
  });

  app.get('/api/settings', (_req, res) => {
    res.json(settings.get());
  });
  app.patch('/api/settings', (req, res) => {
    res.json(settings.update(req.body));
    dispatcher.tick();
  });

  // ── Token usage (usage.ts) ────────────────────────────────────────────
  app.get('/api/usage', (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    res.json(usage.summary(days));
  });
  /** A card's or chat's usage, with the context window of the model that answered last. */
  app.get('/api/cards/:id/usage', (req, res) => {
    const u = usage.conversation(kanban.get(req.params.id).conversationId);
    const m = u.lastModelId ? models.list().find((x) => x.id === u.lastModelId) : undefined;
    res.json({ ...u, contextWindow: m?.contextWindow ?? null });
  });

  // ── ChatGPT plan (chatgpt.ts): the status and actions, never a token ──
  app.get('/api/chatgpt', (_req, res) => {
    res.json(chatgpt.status());
  });
  app.post('/api/chatgpt/login', async (_req, res) => {
    res.json(await chatgpt.login());
  });
  app.post('/api/chatgpt/cancel', (_req, res) => {
    chatgpt.cancel();
    res.json(chatgpt.status());
  });
  app.post('/api/chatgpt/logout', async (_req, res) => {
    res.json(await chatgpt.logout());
  });
  app.patch('/api/chatgpt', (req, res) => {
    res.json(chatgpt.update(req.body));
  });
  // ── Claude plan (claude-plan.ts): status, settings check and actions, never a token ──
  app.get('/api/claude', (_req, res) => {
    res.json(claude.status());
  });
  app.post('/api/claude/login', async (_req, res) => {
    res.json(await claude.login());
  });
  app.post('/api/claude/cancel', (_req, res) => {
    claude.cancel();
    res.json(claude.status());
  });
  app.post('/api/claude/logout', async (_req, res) => {
    res.json(await claude.logout());
  });
  app.patch('/api/claude', (req, res) => {
    res.json(claude.update(req.body));
  });
  app.get('/api/claude/models', async (_req, res) => {
    res.json(await claude.models());
  });
  app.get('/api/chatgpt/models', async (_req, res) => {
    res.json(await chatgpt.models());
  });

  // ── Anthropic accounts (accounts.ts): keys go in, never out ──────────
  app.get('/api/accounts', (_req, res) => {
    res.json(accounts.list());
  });
  app.post('/api/accounts', (req, res) => {
    res.status(201).json(accounts.create(req.body));
    dispatcher.tick();
  });
  app.patch('/api/accounts/:id', (req, res) => {
    res.json(accounts.update(req.params.id, req.body));
    dispatcher.tick();
  });
  app.put('/api/accounts/order', (req, res) => {
    res.json(accounts.reorder((req.body as { ids?: string[] }).ids ?? []));
  });
  app.delete('/api/accounts/:id', (req, res) => {
    accounts.remove(req.params.id);
    res.status(204).end();
  });
  app.post('/api/accounts/:id/test', async (req, res) => {
    res.json(await accounts.test(req.params.id));
  });

  // ── Local model server (local.ts) ────────────────────────────────────
  app.get('/api/local', async (_req, res) => {
    await local.probe();
    res.json(local.status());
  });
  app.patch('/api/local', (req, res) => {
    res.json(local.update(req.body));
  });
  app.post('/api/local/start', async (_req, res) => {
    await local.start();
    res.json(local.status());
  });
  app.post('/api/local/stop', async (_req, res) => {
    await local.stop();
    res.json(local.status());
  });
  app.post('/api/local/install', async (_req, res) => {
    await local.install();
    res.json(local.status());
  });
  app.get('/api/local/models', async (_req, res) => {
    res.json({ models: await local.list(), pulls: local.pulls_() });
  });
  app.post('/api/local/pull', async (req, res) => {
    res.json(await local.pull(String((req.body as { name?: unknown }).name ?? '')));
  });
  app.delete('/api/local/pull', (req, res) => {
    local.cancelPull(String(req.query.name ?? ''));
    res.status(204).end();
  });
  app.delete('/api/local/models', async (req, res) => {
    await local.remove(String(req.query.name ?? ''));
    res.status(204).end();
  });
  app.post('/api/local/load', async (req, res) => {
    const b = req.body as { name?: unknown; keep?: unknown };
    await local.load(String(b.name ?? ''), b.keep !== false);
    res.status(204).end();
  });
  /** Make an installed local model usable by agents: an Atlas model pointing at the server's OpenAI endpoint. */
  app.post('/api/local/use', (req, res) => {
    const name = String((req.body as { name?: unknown }).name ?? '');
    if (!name) throw new InvalidError('name required');
    const existing = models.list().find((m) => m.name === name && local.serves(m.baseUrl));
    if (existing) return void res.json(existing);
    const base = (name.split('/').pop() ?? name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-$/g, '').slice(0, 26).replace(/-$/, '') || 'local';
    let id = base;
    for (let i = 2; models.list().some((m) => m.id === id); i++) id = `${base}-${i}`;
    res.json(
      models.create({
        id,
        provider: 'openai_compat',
        name,
        baseUrl: local.url + '/v1',
        credentialEnv: null,
        maxTokens: 16000,
        contextWindow: local.contextLength || DEFAULT_CONTEXT_WINDOW.openai_compat,
      } as Parameters<typeof models.create>[0]),
    );
  });

  // ── Schedules ─────────────────────────────────────────────────────────
  app.get('/api/schedules', (_req, res) => {
    res.json(schedules.list());
  });
  /** Next firings of a draft, for the form's preview. Errors (bad cron, unknown zone) come back as 400 with the reason. */
  app.post('/api/schedules/preview', (req, res) => {
    const w = ScheduleWhen.parse(req.body);
    const timezone = typeof req.body?.timezone === 'string' && req.body.timezone ? req.body.timezone : localTimeZone();
    if (!isTimeZone(timezone)) throw new InvalidError(`unknown time zone ${timezone}`);
    res.json({ timezone, next: upcoming({ ...w, timezone }, new Date(), 3) });
  });
  app.get('/api/schedules/:id', (req, res) => {
    res.json(schedules.get(req.params.id));
  });
  app.post('/api/schedules', (req, res) => {
    res.status(201).json(schedules.create(req.body, 'can'));
  });
  app.patch('/api/schedules/:id', (req, res) => {
    res.json(schedules.update(req.params.id, req.body));
  });
  app.delete('/api/schedules/:id', (req, res) => {
    schedules.remove(req.params.id);
    res.status(204).end();
  });
  /** Fire now (the planned next run stays). Answers with the card that got the prompt. */
  app.post('/api/schedules/:id/run', (req, res) => {
    res.json(schedules.runNow(req.params.id));
  });

  if (deps.uiDir && existsSync(deps.uiDir)) {
    const uiDir = deps.uiDir;
    app.use(express.static(uiDir));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(uiDir, 'index.html'));
    });
  }

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) res.status(400).json({ error: 'invalid request', issues: err.issues });
    else if (err instanceof StaleVersionError) res.status(409).json({ error: err.message, current: err.current });
    else if (err instanceof NotFoundError) res.status(404).json({ error: err.message });
    else if (err instanceof ConflictError) res.status(409).json({ error: err.message });
    else if (err instanceof InvalidError) res.status(400).json({ error: err.message });
    else {
      console.error(err);
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
  app.use(onError);

  const server = createServer(app);
  const wss = new WebSocketServer({
    server,
    path: '/api/events',
    // Same rules as HTTP: no cross-site page, and a session in server mode.
    verifyClient: (info: { req: IncomingMessage }) => !auth.crossSite(info.req) && auth.authenticated(info.req),
  });
  bus.on((e) => {
    const data = JSON.stringify(e);
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(data);
  });
  // http.Server.close() waits for upgraded WebSocket sockets, so end them explicitly or shutdown hangs.
  const close = server.close.bind(server);
  server.close = (cb?: (err?: Error) => void) => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    return close(cb);
  };
  return server;
}