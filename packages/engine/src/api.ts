import express, { type ErrorRequestHandler, type Request } from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { WebSocketServer } from 'ws';
import { ZodError } from 'zod';
import { AddCardImages, CreateCard, CreateModelRequest, CreateSecret, SecretsPassword, UnlockSecrets, UpdateSecret, IMAGE_MAX_BYTES, IMAGE_MAX_PER_TASK, isTimeZone, PostMessage, RewindRequest, SlashCommand, TriggerPreview, UpdateModelRequest, UpdateVoice } from '@atlas/shared';
import type { Agents } from './agents.ts';
import type { Models } from './models.ts';
import type { Runner } from './runner.ts';
import type { Rewinds } from './rewind.ts';
import type { Slash } from './slash.ts';
import type { Dispatcher } from './dispatcher.ts';
import type { Settings } from './settings.ts';
import { parseMemoryRef, type Memories } from './memory.ts';
import type { MemoryCleanup } from './cleanup.ts';
import { localTimeZone, upcoming, type Workflows } from './workflows.ts';
import type { Secrets } from './secrets.ts';
import { SecretsPasswordError } from './secretFile.ts';
import type { Documents } from './documents.ts';
import type { Projects } from './projects.ts';
import { findSection, formatDocRef, splitSections } from '@atlas/shared';
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
import type { Updater } from './updater.ts';
import type { ShellEnv } from './shellEnv.ts';
import { DEFAULT_CONTEXT_WINDOW, MEMORY_BUDGET, MEMORY_BUDGET_GLOBAL, type About, type MemoryBudget, type Timeline } from '@atlas/shared';

/** Who the UI acts as. One user (design §1). */
const USER = 'user';
/** Served files up to this size are checked for secret values (#226); bigger ones are sent as they are. */
export const MAX_SERVED_REDACT = 10 * 1024 * 1024;

import { Auth, SESSION_COOKIE } from './auth.ts';
import { Uploads } from './uploads.ts';
import { TaskImages } from './taskImages.ts';

export function createApi(deps: {
  kanban: Kanban;
  agents: Agents;
  models: Models;
  runner: Runner;
  rewinds: Rewinds;
  slash: Slash;
  dispatcher: Dispatcher;
  settings: Settings;
  documents: Documents;
  memories: Memories;
  cleanup: MemoryCleanup;
  workflows: Workflows;
  local: Local;
  accounts: Accounts;
  chatgpt: ChatGpt;
  claude: ClaudePlan;
  plans: PlanAccounts;
  notifications: Notifications;
  usage: Usage;
  /** Desktop only; null elsewhere (the /api/voice routes answer 404). */
  voice: Voice | null;
  updater: Updater;
  /** Agent shells' PATH (#136), shown in Settings → About; omitted = not reported. */
  shellEnv?: ShellEnv;
  bus: Bus;
  dataDir: string;
  version: string;
  uiDir?: string;
  secrets: Secrets;
  env: NodeJS.ProcessEnv;
  /** Login and cross-site checks (auth.ts). */
  auth: Auth;
  projects: Projects;
}): Server {
  const { kanban, agents, models, runner, rewinds, slash, dispatcher, settings, documents, memories, cleanup, workflows, local, accounts, chatgpt, claude, plans, notifications, usage, bus, auth, projects } = deps;
  const app = express();
  const uploads = new Uploads(deps.dataDir);
  const taskImages = new TaskImages(deps.dataDir, uploads);
  try {
    uploads.prune();
  } catch (e) {
    console.error('pruning staged uploads failed', e);
  }
  try {
    taskImages.sweep(kanban.list({ includeArchived: true }).flatMap((c) => c.images.map((im) => im.path)));
  } catch (e) {
    console.error('sweeping task images failed', e);
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
    const about: About = { version: deps.version, dataDir: deps.dataDir, server: auth.enabled, voice: !!deps.voice, shellPath: deps.shellEnv?.status() ?? null };
    res.json(about);
  });

  // ── App updates (#123): status, « Check now », Update (Master's click) ──
  app.get('/api/update', (_req, res) => {
    res.json(deps.updater.status());
  });
  app.post('/api/update/check', async (_req, res) => {
    res.json(await deps.updater.check());
  });
  app.post('/api/update/install', async (_req, res) => {
    res.json(await deps.updater.install());
  });


  /**
   * Lists take `?project=<id or name>` (#213): that project only. Without it, every active project; `?archived=1`
   * shows archived projects' too.
   */
  const projectQuery = (req: Request): { project?: string; archived: boolean } => {
    const q = req.query as Record<string, unknown>;
    return { project: typeof q.project === 'string' && q.project ? projects.get(q.project).id : undefined, archived: q.archived === '1' || q.archived === 'true' };
  };
  app.get('/api/cards', (req, res) => {
    const { project, archived } = projectQuery(req);
    res.json(kanban.list({ project, archivedProjects: archived }));
  });
  // `uploads`: staged images (POST /api/uploads) attached to the new task, placed and listed in its row (#119).
  app.post('/api/cards', async (req, res) => {
    refuseRunning(req.body);
    const input = CreateCard.parse(req.body);
    res.status(201).json(await taskImages.attach(input.uploads, (images) => kanban.create(input, USER, null, images)));
  });
  /** Add staged images to a task (#119): at most IMAGE_MAX_PER_TASK in all. */
  app.post('/api/cards/:id/images', async (req, res) => {
    const { uploads: ids } = AddCardImages.parse(req.body);
    const card = kanban.get(req.params.id);
    if (card.board === 'direct') throw new InvalidError('a direct chat has no description: send the image as a message');
    if (card.images.length + ids.length > IMAGE_MAX_PER_TASK)
      throw new InvalidError(`${IMAGE_MAX_PER_TASK} images per task at most (it has ${card.images.length})`);
    // Read the list again inside the write: another add may have landed while the files were copied.
    res.status(201).json(
      await taskImages.attach(ids, (images) => {
        const now = kanban.get(card.id).images;
        if (now.length + images.length > IMAGE_MAX_PER_TASK) throw new InvalidError(`${IMAGE_MAX_PER_TASK} images per task at most (it has ${now.length})`);
        return kanban.setImages(card.id, [...now, ...images], USER);
      }),
    );
  });
  /** Remove one of a task's images (?path=): the row first, then its file. */
  app.delete('/api/cards/:id/images', (req, res) => {
    const path = String(req.query.path ?? '');
    const card = kanban.get(req.params.id);
    const gone = card.images.filter((im) => im.path === path);
    if (!gone.length) throw new NotFoundError(`no image ${path} on this task`);
    const updated = kanban.setImages(card.id, card.images.filter((im) => im.path !== path), USER);
    taskImages.drop(gone);
    res.json(updated);
  });
  app.get('/api/cards/:id', (req, res) => {
    res.json(kanban.get(req.params.id));
  });
  app.patch('/api/cards/:id', (req, res) => {
    refuseRunning(req.body);
    res.json(kanban.update(req.params.id, req.body, USER)); // the dispatcher reacts to the change
  });
  app.delete('/api/cards/:id', (req, res) => {
    const { images } = kanban.get(req.params.id);
    kanban.remove(req.params.id);
    taskImages.drop(images);
    res.status(204).end();
  });
  app.get('/api/cards/:id/messages', (req, res) => {
    res.json(kanban.messages(req.params.id));
  });
  app.post('/api/cards/:id/messages', async (req, res) => {
    const { text, ref, uploads: ids } = PostMessage.parse(req.body);
    const card = kanban.get(req.params.id);
    projects.assertActive(card.projectId, 'its tasks and chats'); // archived (#213): read-only
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
    // The agent's workspace in the chat's project (#214).
    const workdir = ids.length ? projects.workspace(card.assignee!, card.projectId) : '';
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
  const stage = async (req: express.Request, res: express.Response) => {
    const name = String(req.query.name ?? 'image');
    if (!Buffer.isBuffer(req.body)) throw new InvalidError('send the image bytes as the request body');
    res.status(201).json(await uploads.stage(name, req.body));
  };
  const rawImage = express.raw({ type: () => true, limit: IMAGE_MAX_BYTES + 1024 });
  app.post('/api/cards/:id/uploads', rawImage, async (req, res) => {
    kanban.get(req.params.id);
    await stage(req, res);
  });
  // No task yet (the New task dialog, #119): staged the same way, attached by POST /api/cards with `uploads`.
  app.post('/api/uploads', rawImage, stage);
  /** A staged image removed before it was sent (×, or the dialog cancelled): its file is deleted now. */
  app.delete('/api/uploads/:id', (req, res) => {
    uploads.discard(req.params.id);
    res.status(204).end();
  });
  /** A picture of this conversation (a thumbnail in the chat): only a path one of its messages references. */
  app.get('/api/cards/:id/image', (req, res, next) => {
    const path = String(req.query.path ?? '');
    const known =
      kanban.get(req.params.id).images.some((im) => im.path === path) ||
      kanban
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
  /** The workflows acting on a task now, with their current step (#258). */
  app.get('/api/cards/:id/workflows', (req, res) => {
    res.json(workflows.onTask(kanban.resolve(req.params.id)));
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
    const timeline: Timeline = { runs: runner.endedRuns(id), rewinds: rewinds.events(id), summary: runner.summaryOf(id), clears: slash.events(id) };
    res.json(timeline);
  });
  app.post('/api/cards/:id/retry', async (req, res) => {
    projects.assertActive(kanban.get(req.params.id).projectId, 'its tasks');
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
  /** Composer slash commands (#99, slash.ts): /clear and /compact [focus]; a running agent is stopped first. */
  app.post('/api/cards/:id/command', async (req, res) => {
    res.json(await slash.run(req.params.id, SlashCommand.parse(req.body ?? {})));
  });
  app.post('/api/clears/:id/undo', (req, res) => {
    res.json(slash.undo(req.params.id));
  });
  app.post('/api/rewinds/:id/undo', async (req, res) => {
    const r = await rewinds.undo(req.params.id);
    // The undone rewind had cut the agent off mid-turn: it picks up where it stopped, as if the user had written.
    if (r.resume) dispatcher.onUserMessage(r.cardId);
    res.json(r);
  });

  /** Direct chats (Kanban.newChat), latest first; the card id is used with the card message/stop/retry/delete routes. */
  app.get('/api/chats', (req, res) => {
    const { project, archived } = projectQuery(req);
    res.json(kanban.directs({ project, archivedProjects: archived }));
  });
  app.post('/api/agents/:id/chats', (req, res) => {
    if (!agents.list().some((a) => a.id === req.params.id)) throw new NotFoundError(`agent ${req.params.id} not found`);
    res.status(201).json(kanban.newChat(req.params.id));
  });
  /** The agent's main chat (v3) in a project (`?project=`, #214; default project without), created on first use. */
  app.post('/api/agents/:id/main-chat', (req, res) => {
    res.json(kanban.mainChat(req.params.id, typeof req.query.project === 'string' ? req.query.project : undefined));
  });
  /** A fresh main chat; the previous one stays in History (the composer's /clear clears the context instead, #99). */
  app.post('/api/agents/:id/main-chat/new', (req, res) => {
    res.status(201).json(kanban.newMainChat(req.params.id, typeof req.query.project === 'string' ? req.query.project : undefined));
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
    res.json(memories.list({ scope: q.scope, project: q.project || undefined, kind: q.kind as never, status: q.status as never, q: q.q || undefined }));
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
  /**
   * Edit, pin, archive ({status: 'archived'}), restore ({status: 'active'}) or move (#215): {scope: 'global'} makes it
   * one of the user's own (every project), {scope: 'shared' | 'agent:<id>', projectId} puts it in a project.
   */
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
  /** An agent's always-on memory in a project (?project=, default the default project) against the budget (#215). */
  app.get('/api/agents/:id/memory-budget', (req, res) => {
    agents.get(req.params.id);
    const projectId = typeof req.query.project === 'string' && req.query.project ? projects.get(req.query.project).id : projects.defaultId();
    const body: MemoryBudget = {
      used: memories.used({ agentId: req.params.id, projectId }),
      limit: MEMORY_BUDGET,
      global: memories.usedGlobal(),
      globalLimit: MEMORY_BUDGET_GLOBAL,
      projectId,
    };
    res.json(body);
  });
  app.get('/api/models', (_req, res) => {
    res.json(models.list());
  });
  app.post('/api/models', (req, res) => {
    res.status(201).json(models.create(CreateModelRequest.parse(req.body)));
  });
  app.patch('/api/models/:id', (req, res) => {
    res.json(models.update(req.params.id, UpdateModelRequest.parse(req.body)));
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
  // ── Documents and side panels (design §16) ───────────────────────────
  app.get('/api/documents', (req, res) => {
    // Without a card: the Library, every artifact re-synced (files changed outside Atlas).
    const { project, archived } = projectQuery(req);
    res.json(typeof req.query.card === 'string' ? documents.list({ cardId: req.query.card }) : documents.library({ project, archived }));
  });
  /** Library search: titles and content, every folder (a content match has a snippet). */
  app.get('/api/documents/search', (req, res) => {
    res.json(documents.search(typeof req.query.q === 'string' ? req.query.q : '', 50, projectQuery(req).project));
  });
  app.post('/api/documents/:id/move', (req, res) => {
    const folderId = (req.body as { folderId?: unknown }).folderId;
    if (folderId !== null && typeof folderId !== 'string') throw new InvalidError('folderId must be a folder id or null (Unfiled)');
    res.json(documents.move(req.params.id, folderId));
  });
  app.get('/api/folders', (req, res) => {
    res.json(documents.folders(projectQuery(req).project));
  });
  /** `projectId`: omitted = the default project. */
  app.post('/api/folders', (req, res) => {
    const b = req.body as { name?: unknown; projectId?: unknown };
    res.status(201).json(documents.createFolder(String(b.name ?? ''), typeof b.projectId === 'string' ? projects.get(b.projectId).id : undefined));
  });
  app.patch('/api/folders/:id', (req, res) => {
    res.json(documents.renameFolder(req.params.id, String((req.body as { name?: unknown }).name ?? '')));
  });
  app.delete('/api/folders/:id', (req, res) => {
    documents.deleteFolder(req.params.id);
    res.status(204).end();
  });
  app.post('/api/documents/:id/pin', (req, res) => {
    const pinned = (req.body as { pinned?: unknown }).pinned;
    if (typeof pinned !== 'boolean') throw new InvalidError('pinned must be true or false');
    res.json(documents.pin(req.params.id, pinned));
  });
  app.get('/api/documents/:id', (req, res) => {
    const v = req.query.version;
    res.json(documents.content(req.params.id, typeof v === 'string' ? Number(v) : undefined));
  });
  /** Delete an artifact for good (#242): file, row, every version, panel tabs. */
  app.delete('/api/documents/:id', (req, res) => {
    const r = documents.remove(req.params.id);
    res.json({ id: r.doc.id, versions: r.versions, file: r.file });
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
  // never runs with the app's origin, even if opened directly in a tab. `:agent` is the agent's id for its home
  // workspace (links made before projects), `<agent>@<project>` for its workspace in another project (#214).
  app.get('/api/files/:agent/{*path}', (req, res, next) => {
    const where = projects.filesDir(req.params.agent);
    const agent = agents.get(where.agentId);
    const root = where.dir;
    const rel = ((req.params as { path?: string[] }).path ?? []).join('/');
    let file = inside(root, rel || '.');
    let size: number;
    try {
      if (statSync(file).isDirectory()) file = inside(root, (rel ? rel + '/' : '') + 'index.html');
      size = statSync(file).size;
    } catch {
      return void res.status(404).json({ error: `no file ${rel} in ${agent.id}'s workspace` });
    }
    res.setHeader('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals');
    // Secret values never leave in a served file (#226): a text file (anything but images, audio, video and fonts; svg
    // is text) is read and its known values sent as [secret NAME]. The file on disk is not rewritten. Dotfiles stay denied.
    res.type(extname(file) || 'application/octet-stream');
    const type = String(res.get('Content-Type') ?? '');
    const media = /^(image|audio|video|font)\//.test(type) && !type.startsWith('image/svg');
    const dotfile = relative(root, file).split(/[\\/]/).some((p) => p.startsWith('.'));
    if (!media && !dotfile && size <= MAX_SERVED_REDACT) {
      const red = deps.secrets.redactBytes(readFileSync(file));
      if (red.hidden) {
        res.setHeader('Cache-Control', 'no-store');
        return void res.send(red.buf);
      }
    }
    res.sendFile(file, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) next(err);
    });
  });

  // Secrets (#206): model keys and agent secrets. Names and metadata only; values go in, never out.
  /** ?project=global: the global ones; ?project=<id>: that project's (#215). */
  app.get('/api/secrets', (req, res) => {
    res.json(deps.secrets.list(typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined));
  });
  // The server's secrets.enc (#208): status for the sidebar badge, unlock, lock now, first or new password.
  // The password is used once to derive the key and is never stored, logged or sent back.
  app.get('/api/secrets/status', (_req, res) => {
    res.json(deps.secrets.status());
  });
  app.post('/api/secrets/unlock', async (req, res) => {
    res.json(await deps.secrets.unlock(UnlockSecrets.parse(req.body).password, 'ui'));
    dispatcher.tick();
  });
  app.post('/api/secrets/lock', (_req, res) => {
    res.json(deps.secrets.lockNow());
  });
  app.post('/api/secrets/password', async (req, res) => {
    res.json(await deps.secrets.setPassword(SecretsPassword.parse(req.body)));
    dispatcher.tick();
  });
  app.post('/api/secrets', (req, res) => {
    res.status(201).json(deps.secrets.create(CreateSecret.parse(req.body), { by: 'user' }));
  });
  app.patch('/api/secrets/:name', (req, res) => {
    res.json(deps.secrets.update(req.params.name, UpdateSecret.parse(req.body), { by: 'user' }));
    dispatcher.tick(); // a grant may let a task waiting on this secret go back to work (#207)
  });
  // A new value: an agent secret's rotation, or a model key (created here when new, like before #206).
  app.put('/api/secrets/:name', (req, res) => {
    const name = req.params.name;
    if (!deps.secrets.store) throw new ConflictError(`this engine reads keys from its environment: set ${name} there and restart it`);
    const value = String((req.body as { value?: unknown }).value ?? '').trim();
    deps.secrets.setValue(name, value, { by: 'user' });
    deps.env[name] = value;
    if (name.startsWith('ATLAS_CLAUDE_')) claude.notify();
    res.status(204).end();
    dispatcher.tick();
  });
  app.delete('/api/secrets/:name', (req, res) => {
    if (!deps.secrets.store) throw new ConflictError('this engine reads keys from its environment');
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
    projects.resume(); // a new lead joins the project: its workspace there, if it needs a clone
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

  // ── Projects (#213, design §17) ─────────────────────────────────────────
  app.get('/api/projects', (req, res) => {
    res.json(projects.list({ archived: projectQuery(req).archived }));
  });
  /** The New project form: is the repo readable with Master's gh login, its default branch, its CLAUDE.md / AGENTS.md. */
  app.get('/api/projects/repo-check', async (req, res) => {
    res.json(await projects.checkRepo(String(req.query.repo ?? '')));
  });
  app.get('/api/projects/:id', (req, res) => {
    res.json(projects.get(req.params.id));
  });
  app.post('/api/projects', (req, res) => {
    res.status(201).json(projects.create(req.body));
  });
  /** Name, lead, members, colour; a repo only while it has none. */
  app.patch('/api/projects/:id', (req, res) => {
    res.json(projects.update(req.params.id, req.body));
    dispatcher.tick(); // a new lead triages the waiting tasks
  });
  /** Archive (nothing deleted): its workflows go off, its runs stop, its tasks and chats become read-only. */
  app.post('/api/projects/:id/archive', (req, res) => {
    const p = projects.get(req.params.id);
    const on = workflows.list({ project: p.id, archived: true }).filter((w) => w.projectId === p.id && w.enabled);
    const archived = projects.archive(p.id); // turns its workflows off in the same transaction
    for (const w of on) bus.emit({ type: 'workflow.updated', workflow: workflows.get(w.id) });
    for (const c of [...kanban.list({ project: p.id, includeArchived: true }), ...kanban.directs({ project: p.id })]) runner.stop(c.id, `project ${p.name} archived`);
    res.json(archived);
  });
  /** « Try again » on a member's failed clone (#214). */
  app.post('/api/projects/:id/members/:agent/retry', (req, res) => {
    res.json(projects.retry(req.params.id, req.params.agent));
  });
  /** Delete a removed member's kept workspace from disk: only on Master's explicit action (#214). */
  app.delete('/api/projects/:id/kept/:agent', (req, res) => {
    res.json(projects.deleteKept(req.params.id, req.params.agent));
  });
  app.post('/api/projects/:id/restore', (req, res) => {
    res.json(projects.restore(req.params.id));
    dispatcher.tick();
  });

  // ── Workflows (#170, design §9) ─────────────────────────────────────────
  app.get('/api/workflows', (req, res) => {
    const { project, archived } = projectQuery(req);
    res.json(workflows.list({ project, archived }));
  });
  /** Next firings of a draft time trigger, for the editor's preview. A bad cron or zone comes back as 400 with the reason. */
  app.post('/api/workflows/preview', (req, res) => {
    const p = TriggerPreview.parse(req.body);
    const timezone = p.timezone || localTimeZone();
    if (!isTimeZone(timezone)) throw new InvalidError(`unknown time zone ${timezone}`);
    if (p.repeat === 'cron' && !p.cron) throw new InvalidError('give the cron expression');
    if (p.repeat === 'at' && !p.at) throw new InvalidError('give the date and time');
    res.json({ timezone, next: upcoming({ kind: p.repeat, cron: p.cron, at: p.at, timezone }, new Date(), 3) });
  });
  app.get('/api/workflows/:id', (req, res) => {
    res.json(workflows.get(req.params.id));
  });
  app.post('/api/workflows', (req, res) => {
    res.status(201).json(workflows.create(req.body, 'user'));
  });
  /** Save the graph; `revision` must be the one loaded, else 409 (saved since). */
  app.put('/api/workflows/:id/graph', (req, res) => {
    res.json(workflows.saveGraph(req.params.id, req.body));
  });
  /** Rename, on/off. */
  /**
   * Master approves every « Run a command » step of that revision (#273): exactly the command, secrets and limit shown.
   * A stale revision is refused (409). Only Master: no agent tool calls these two routes.
   */
  app.post('/api/workflows/:id/approve', (req, res) => {
    res.json(workflows.approve(req.params.id, req.body ?? {}));
  });
  app.post('/api/workflows/:id/reject', (req, res) => {
    res.json(workflows.reject(req.params.id));
  });
  app.patch('/api/workflows/:id', (req, res) => {
    res.json(workflows.update(req.params.id, req.body));
  });
  app.delete('/api/workflows/:id', (req, res) => {
    workflows.remove(req.params.id);
    res.status(204).end();
  });
  /** Run now (also when off). A run still going makes it a skipped run, returned as such. */
  app.post('/api/workflows/:id/run', (req, res) => {
    res.json(workflows.runNow(req.params.id, req.body ?? {}));
  });
  /** The fields a step can use as {{field}} (#258); `?node=` narrows to what can come before that step. */
  app.get('/api/workflows/:id/fields', (req, res) => {
    res.json(workflows.fields(req.params.id, typeof req.query.node === 'string' && req.query.node ? req.query.node : undefined));
  });
  app.get('/api/workflows/:id/runs', (req, res) => {
    res.json(workflows.runs(req.params.id));
  });
  /** One run with its steps. */
  app.get('/api/workflow-runs/:id', (req, res) => {
    res.json(workflows.run(req.params.id));
  });
  /** What a run knows: its task, PR, project, event and the ended steps' exit, summary and task (#258). */
  app.get('/api/workflow-runs/:id/context', (req, res) => {
    res.json(workflows.context(req.params.id));
  });
  /** A step that couldn't run (#261): try it again now, or take its negative exit (« refused », « failed »…). */
  app.post('/api/workflow-runs/:id/retry', (req, res) => {
    res.json(workflows.retryNow(req.params.id));
  });
  app.post('/api/workflow-runs/:id/follow', (req, res) => {
    res.json(workflows.followNegative(req.params.id, 'user'));
  });
  /** A condition's tests on a past run, before saving (#261): body { run, config }. */
  app.post('/api/workflows/:id/try-condition', (req, res) => {
    res.json(workflows.tryCondition(req.params.id, req.body));
  });
  app.post('/api/workflow-runs/:id/stop', (req, res) => {
    res.json(workflows.stopRun(req.params.id, 'user'));
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
    else if (err instanceof NotFoundError) res.status(404).json({ error: err.message });
    else if (err instanceof SecretsPasswordError) res.status(403).json({ error: err.message });
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
/** « running » means a run holds the card: only the dispatcher sets it, when a run starts (design §7). By hand it would strand the card. */
function refuseRunning(body: unknown): void {
  if ((body as { status?: unknown } | null)?.status === 'running')
    throw new InvalidError('a task cannot be set to Running by hand: Running is set by the dispatcher when a run starts (move it to Ready instead)');
}
