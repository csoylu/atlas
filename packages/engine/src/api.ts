import express, { type ErrorRequestHandler } from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WebSocketServer } from 'ws';
import { ZodError } from 'zod';
import { IMAGE_MAX_BYTES, isTimeZone, PostMessage, RewindRequest, ScheduleWhen, UpdateVoice } from '@atlas/shared';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Runner } from './runner.ts';
import type { Rewinds } from './rewind.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { Settings } from './settings.ts';
import { parseMemoryRef, type Memories } from './memory.ts';
import type { MemoryCleanup } from './cleanup.ts';
import { localTimeZone, upcoming, type Schedules } from './schedules.ts';
import { isTokenEntry, SECRET_NAME, type SecretStore } from './secrets.ts';
import { StaleVersionError, type Canvases } from './canvas.ts';
import type { Documents } from './documents.ts';
import { findSection, formatDocRef, splitSections } from '@atlas/shared';
import { workdirOf } from './agents.ts';
import { inside } from './tools.ts';
import { statSync } from 'node:fs';
import { ConflictError, InvalidError, NotFoundError, type Kanban } from './kanban.ts';
import type { Bus } from './events.ts';
import type { Local } from './local.ts';
import type { Accounts } from './accounts.ts';
import type { ChatGpt } from './chatgpt.ts';
import type { ClaudePlan } from './claude-plan.ts';
import type { PlanAccounts } from './plan-accounts.ts';
import type { Notifications } from './notifications.ts';
import type { Usage } from './usage.ts';
import type { Voice } from './voice.ts';
import { DEFAULT_CONTEXT_WINDOW, MEMORY_BUDGET, type About, type Timeline } from '@atlas/shared';

/** Who the UI acts as. One user (design §1). */
const USER = 'user';

import { Auth, SESSION_COOKIE } from './auth.ts';
import { Uploads } from './uploads.ts';

export function createApi(deps: {
  kanban: Kanban;
  agents: Agents;
  models: Models;
  runner: Runner;
  rewinds: Rewinds;
  dispatcher: Dispatcher;
  settings: Settings;
  canvases: Canvases;
  documents: Documents;
  memories: Memories;
  cleanup: MemoryCleanup;
  schedules: Schedules;
  local: Local;
  accounts: Accounts;
  chatgpt: ChatGpt;
  claude: ClaudePlan;
  plans: PlanAccounts;
  notifications: Notifications;
  usage: Usage;
  /** Desktop only; null elsewhere (the /api/voice routes answer 404). */
  voice: Voice | null;
  bus: Bus;
  dataDir: string;
  version: string;
  uiDir?: string;
  secrets?: SecretStore;
  env: NodeJS.ProcessEnv;
  /** Login and cross-site checks (auth.ts). */
  auth: Auth;
}): Server {
  const { kanban, agents, models, runner, rewinds, dispatcher, settings, canvases, documents, memories, cleanup, schedules, local, accounts, chatgpt, claude, plans, notifications, usage, bus, auth } = deps;
  const app = express();
  const uploads = new Uploads(deps.dataDir);
  try {
    uploads.prune();
  } catch (e) {
    console.error('pruning staged uploads failed', e);
  }
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

  // ── About (Settings → About & data) ──────────────────────────────────
  app.get('/api/about', (_req, res) => {
    const about: About = { version: deps.version, dataDir: deps.dataDir, server: auth.enabled, voice: !!deps.voice };
    res.json(about);
  });


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
  app.post('/api/cards/:id/messages', async (req, res) => {
    const { text, ref, uploads: ids } = PostMessage.parse(req.body);
    const card = kanban.get(req.params.id);
    if (ids.length && !card.assignee) throw new InvalidError('assign an agent before sending images: they go into its workspace');
    // The card's state before this message: « Rewind to here » / Stop go back to it (rewind.ts).
    const snapshot = rewinds.beforeUserMessage(req.params.id);
    // « Ask about this »: the quoted document part goes first, so the agent knows exactly what is meant.
    let quote: string | null = null;
    if (ref) {
      const versions = documents.versions(ref.docId);
      // The version the user was looking at, or the latest if it is no longer kept.
      const { doc, content } = documents.content(ref.docId, versions.some((v) => v.version === ref.version) ? ref.version : undefined);
      const section = ref.section !== null && doc.kind === 'markdown' ? (findSection(splitSections(content), ref.section) ?? null) : null;
      quote = formatDocRef(doc, ref.version, section);
    }
    // Pasted/dropped images: copied into the agent's workspace, then the message row written with their blocks (uploads.ts).
    const workdir = ids.length ? workdirOf(agents.get(card.assignee!), deps.dataDir) : '';
    const message = await uploads.send(ids, workdir, (images) =>
      kanban.appendMessage(req.params.id, 'user', USER, [
        ...(quote ? [{ type: 'text' as const, text: quote }] : []),
        ...(text ? [{ type: 'text' as const, text }] : []),
        ...images.flatMap((im) => [im, { type: 'text' as const, text: `[attached: ${relative(workdir, im.path)}]` }]),
      ]),
    );
    rewinds.record(req.params.id, message.seq, snapshot);
    dispatcher.onUserMessage(req.params.id); // unblocks, resumes review, or gets a chat reply
    runner.nameChat(req.params.id); // direct chats: the user's 3rd message has the model title the chat
    res.status(201).json(message);
  });
  /** Stage a pasted/dropped image (raw body, the file name in ?name=): checked now, sent with the next message. */
  app.post('/api/cards/:id/uploads', express.raw({ type: () => true, limit: IMAGE_MAX_BYTES + 1024 }), async (req, res) => {
    kanban.get(req.params.id);
    const name = String(req.query.name ?? 'image');
    if (!Buffer.isBuffer(req.body)) throw new InvalidError('send the image bytes as the request body');
    res.status(201).json(await uploads.stage(name, req.body));
  });
  /** A picture of this conversation (a thumbnail in the chat): only a path one of its messages references. */
  app.get('/api/cards/:id/image', (req, res, next) => {
    const path = String(req.query.path ?? '');
    const known = kanban
      .messages(req.params.id)
      .some((m) => m.content.some((b) => (b.type === 'image' && b.path === path) || (b.type === 'tool_result' && b.images?.some((i) => i.path === path))));
    if (!known) throw new NotFoundError(`no image ${path} in this conversation`);
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.sendFile(path, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: `the file ${path} no longer exists` });
      else if (err) next(err);
    });
  });
  app.get('/api/cards/:id/runs', (req, res) => {
    kanban.get(req.params.id);
    res.json(runner.runs(req.params.id));
  });
  app.get('/api/cards/:id/tool-calls', (req, res) => {
    kanban.get(req.params.id);
    res.json(runner.toolCalls(req.params.id));
  });
  /** What the chat shows between messages (#66): unfinished runs, rewinds in effect, where the context summary ends. */
  app.get('/api/cards/:id/timeline', (req, res) => {
    const id = req.params.id;
    const timeline: Timeline = { runs: runner.endedRuns(id), rewinds: rewinds.events(id), summary: runner.summaryOf(id) };
    res.json(timeline);
  });
  app.post('/api/cards/:id/retry', async (req, res) => {
    await dispatcher.retry(req.params.id);
    res.json(kanban.get(req.params.id));
  });
  app.post('/api/cards/:id/stop', (req, res) => {
    res.json({ stopped: runner.stop(req.params.id) });
  });
  /** Rewind (rewind.ts): to the user message `seq`, or without it (Stop/Esc) the turn being answered; null = just stopped. */
  app.get('/api/cards/:id/rewind', async (req, res) => {
    const seq = Number(req.query.seq);
    if (!Number.isInteger(seq) || seq < 1) throw new InvalidError('seq: the number of a message');
    res.json(await rewinds.preview(req.params.id, seq));
  });
  app.post('/api/cards/:id/rewind', async (req, res) => {
    const { seq } = RewindRequest.parse(req.body ?? {});
    res.json(await rewinds.rewind(req.params.id, seq));
  });
  app.post('/api/rewinds/:id/undo', async (req, res) => {
    const r = await rewinds.undo(req.params.id);
    // The undone rewind had cut the agent off mid-turn: it picks up where it stopped, as if the user had written.
    if (r.resume) dispatcher.onUserMessage(r.cardId);
    res.json(r);
  });

  /** Direct chats (Kanban.newChat), latest first; the card id is used with the card message/stop/retry/delete routes. */
  app.get('/api/chats', (_req, res) => {
    res.json(kanban.directs());
  });
  app.post('/api/agents/:id/chats', (req, res) => {
    if (!agents.list().some((a) => a.id === req.params.id)) throw new NotFoundError(`agent ${req.params.id} not found`);
    res.status(201).json(kanban.newChat(req.params.id));
  });
  /** The agent's main chat (v3), created on first use. */
  app.post('/api/agents/:id/main-chat', (req, res) => {
    res.json(kanban.mainChat(req.params.id));
  });
  /** `/clear`: a fresh main chat; the previous one stays in History. */
  app.post('/api/agents/:id/main-chat/new', (req, res) => {
    res.status(201).json(kanban.newMainChat(req.params.id));
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
  // ── Memory v2 (design §8): Settings → Memory, the daily digest ────────
  app.get('/api/memories', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.json(memories.list({ scope: q.scope, kind: q.kind as never, status: q.status as never, q: q.q || undefined }));
  });
  app.post('/api/memories', (req, res) => {
    res.status(201).json(memories.add(req.body, USER));
  });
  /** Changes since `since` (ISO time; default the last 24 h), newest first. */
  app.get('/api/memories/changes', (req, res) => {
    const since = typeof req.query.since === 'string' ? req.query.since : new Date(Date.now() - 24 * 3600_000).toISOString();
    if (Number.isNaN(Date.parse(since))) throw new InvalidError('since: an ISO time');
    res.json(memories.changes(new Date(since).toISOString()));
  });
  app.post('/api/memories/changes/:id/undo', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new InvalidError('change id: a number');
    res.json(memories.undo(id, USER));
  });
  app.get('/api/memories/:id', (req, res) => {
    res.json(memories.get(parseMemoryRef(req.params.id)));
  });
  /** Edit, pin, archive ({status: 'archived'}) or restore ({status: 'active'}). */
  app.patch('/api/memories/:id', (req, res) => {
    res.json(memories.update(parseMemoryRef(req.params.id), req.body, USER));
  });
  // ── Weekly memory cleanup (#83): its proposals, approved or rejected one by one ────────
  app.get('/api/memory-proposals', (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    if (q.status && !['pending', 'approved', 'rejected'].includes(q.status)) throw new InvalidError('status: pending, approved or rejected');
    res.json(cleanup.list({ cardId: q.cardId || undefined, status: (q.status || undefined) as never }));
  });
  const proposalId = (raw: string) => {
    const id = Number(/^p?(\d+)$/i.exec(raw)?.[1] ?? NaN);
    if (!Number.isInteger(id)) throw new InvalidError('proposal id: a number');
    return id;
  };
  app.post('/api/memory-proposals/:id/approve', (req, res) => {
    res.json(cleanup.approve(proposalId(req.params.id), USER));
  });
  app.post('/api/memory-proposals/:id/reject', (req, res) => {
    res.json(cleanup.reject(proposalId(req.params.id)));
  });
  /** An agent's always-on memory size against the budget. */
  app.get('/api/agents/:id/memory-budget', (req, res) => {
    agents.get(req.params.id);
    res.json({ used: memories.used(req.params.id), limit: MEMORY_BUDGET });
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

  // ── Documents and side panels (design §16) ───────────────────────────
  app.get('/api/documents', (req, res) => {
    // Without a card: the Library, every document re-synced (files changed outside Atlas, canvases as whiteboards).
    res.json(typeof req.query.card === 'string' ? documents.list({ cardId: req.query.card }) : documents.library());
  });
  app.post('/api/documents/:id/pin', (req, res) => {
    const pinned = (req.body as { pinned?: unknown }).pinned;
    if (typeof pinned !== 'boolean') throw new InvalidError('pinned must be true or false');
    res.json(documents.pin(req.params.id, pinned));
  });
  /** The whiteboard document of a canvas (created on first use): #/canvas/<id> links and « New whiteboard ». */
  app.post('/api/canvases/:id/document', (req, res) => {
    res.json(documents.whiteboard(req.params.id, USER));
  });
  app.get('/api/documents/:id', (req, res) => {
    const v = req.query.version;
    res.json(documents.content(req.params.id, typeof v === 'string' ? Number(v) : undefined));
  });
  app.get('/api/documents/:id/versions', (req, res) => {
    res.json(documents.versions(req.params.id));
  });
  app.post('/api/documents/:id/restore/:version', (req, res) => {
    res.json(documents.restore(req.params.id, Number(req.params.version), USER));
  });
  app.get('/api/chats/:id/panel', (req, res) => {
    res.json(documents.tabs(req.params.id));
  });
  app.post('/api/chats/:id/panel/open', (req, res) => {
    const b = req.body as { docId?: unknown; section?: unknown };
    res.json(documents.open(req.params.id, String(b.docId ?? ''), USER, typeof b.section === 'string' ? b.section : null));
  });
  app.post('/api/chats/:id/panel/close', (req, res) => {
    const b = req.body as { docId?: unknown };
    res.json(documents.close(req.params.id, typeof b.docId === 'string' ? b.docId : null));
  });
  app.post('/api/chats/:id/panel/focus', (req, res) => {
    res.json(documents.focus(req.params.id, String((req.body as { docId?: unknown }).docId ?? '')));
  });
  app.post('/api/chats/:id/panel/seen', (req, res) => {
    res.json(documents.seen(req.params.id, String((req.body as { docId?: unknown }).docId ?? '')));
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
    res.json({ store: deps.secrets?.label ?? null, names: (deps.secrets?.names() ?? []).filter((n) => !isTokenEntry(n)) });
  });
  app.put('/api/secrets/:name', (req, res) => {
    const name = req.params.name;
    if (!deps.secrets) throw new ConflictError(`this engine reads keys from its environment: set ${name} there and restart it`);
    if (!SECRET_NAME.test(name)) throw new ConflictError(`${name} is not a valid variable name (A-Z, 0-9, _)`);
    if (isTokenEntry(name)) throw new ConflictError(`${name} belongs to a sign-in (ChatGPT or Claude plan)`);
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
    if (isTokenEntry(req.params.name)) throw new ConflictError('sign out instead (Settings → Subscriptions)');
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
    const { lastAccountId, ...rest } = u;
    const acc = lastAccountId ? plans.find(lastAccountId) : null;
    res.json({ ...rest, contextWindow: m?.contextWindow ?? null, plan: acc ? { provider: acc.provider, label: acc.label, quota: acc.quota } : null });
  });

  // ── Plan subscriptions (plan-accounts.ts): several Claude / ChatGPT sign-ins, in failover order ──
  const planOf = (provider: string) => (provider === 'chatgpt' ? chatgpt : claude);
  app.post('/api/plan-accounts', (req, res) => {
    const r = plans.create(req.body);
    res.status(201).json(planOf(r.provider).status());
  });
  app.patch('/api/plan-accounts/:id', (req, res) => {
    const r = plans.update(req.params.id, req.body);
    res.json(planOf(r.provider).status());
  });
  app.put('/api/plan-accounts/order', (req, res) => {
    const b = req.body as { provider?: string; ids?: string[] };
    const provider = b.provider === 'chatgpt' ? 'chatgpt' : 'claude_plan';
    plans.reorder(provider, b.ids ?? []);
    res.json(planOf(provider).status());
  });
  app.delete('/api/plan-accounts/:id', async (req, res) => {
    const r = plans.row(req.params.id);
    res.json(await planOf(r.provider).remove(r.id));
  });
  app.get('/api/notifications', (_req, res) => {
    res.json(notifications.list());
  });
  // ── Inbox (design §16): needs you + updates; read, archive, archive all read ──
  app.get('/api/inbox', (_req, res) => {
    res.json(notifications.inbox());
  });
  const notificationId = (raw: string) => {
    const id = Number(raw);
    if (!Number.isInteger(id) || id < 1) throw new InvalidError('id: the number of a notification');
    return id;
  };
  app.post('/api/notifications/archive-read', (_req, res) => {
    res.json({ archived: notifications.archiveRead() });
  });
  app.post('/api/notifications/:id/read', (req, res) => {
    notifications.read(notificationId(req.params.id));
    res.status(204).end();
  });
  app.post('/api/notifications/:id/archive', (req, res) => {
    notifications.archive(notificationId(req.params.id));
    res.status(204).end();
  });

  // ── ChatGPT plan (chatgpt.ts): the status and actions, never a token ──
  app.get('/api/chatgpt', (_req, res) => {
    res.json(chatgpt.status());
  });
  app.post('/api/chatgpt/login', async (req, res) => {
    res.json(await chatgpt.login(req.body?.accountId));
  });
  app.post('/api/chatgpt/cancel', (_req, res) => {
    chatgpt.cancel();
    res.json(chatgpt.status());
  });
  app.post('/api/chatgpt/logout', async (req, res) => {
    res.json(await chatgpt.logout(req.body?.accountId));
  });
  app.patch('/api/chatgpt', (req, res) => {
    res.json(chatgpt.update(req.body));
  });
  // ── Claude plan (claude-plan.ts): status, settings check and actions, never a token ──
  app.get('/api/claude', (_req, res) => {
    res.json(claude.status());
  });
  app.post('/api/claude/login', async (req, res) => {
    res.json(await claude.login(req.body?.accountId));
  });
  app.post('/api/claude/complete', async (req, res) => {
    res.json(await claude.completeLogin(req.body?.code));
  });
  app.post('/api/claude/cancel', (_req, res) => {
    claude.cancel();
    res.json(claude.status());
  });
  app.post('/api/claude/logout', async (req, res) => {
    res.json(await claude.logout(req.body?.accountId));
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

  // ── Voice mode (voice.ts, desktop only) ───────────────────────────────
  const voice = () => {
    if (!deps.voice) throw new NotFoundError('voice mode is only available in the desktop app');
    return deps.voice;
  };
  app.get('/api/voice', (_req, res) => {
    res.json(voice().status());
  });
  app.patch('/api/voice', async (req, res) => {
    res.json(await voice().update(req.body));
  });
  /** Retry a failed model download. */
  app.post('/api/voice/download', (_req, res) => {
    void voice().ensureModels();
    res.json(voice().status());
  });
  app.post('/api/voice/test', async (req, res) => {
    const v = voice();
    const name = UpdateVoice.shape.voice.unwrap().parse((req.body as { voice?: unknown }).voice ?? v.status().voice);
    res.type('audio/wav').send(await v.test(name, settings.user().name));
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
    res.status(201).json(schedules.create(req.body, 'user'));
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
    else if ((err as { type?: string }).type === 'entity.too.large')
      res.status(413).json({ error: `the request is over ${((err as { limit: number }).limit / 1024 / 1024).toFixed(1)} MB: images over 10.0 MB are refused` });
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