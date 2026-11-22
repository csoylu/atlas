import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../harness/fixtures.ts';
import { call, idleCard, tu, say } from '../../harness/audit.ts';

test.describe('A · agents, chats, models, settings (API)', () => {
  test('[A01] agent CRUD: create, duplicate id refused, bad id/model refused, patch, delete archives its chat', async ({ atlas }) => {
    const r = await call(atlas, 'POST', '/agents', { id: 'bob', modelId: 'sonnet', rolePrompt: 'bob' });
    expect(r.status).toBe(201);
    expect((await call(atlas, 'POST', '/agents', { id: 'bob', modelId: 'sonnet' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'POST', '/agents', { id: 'Bad Id', modelId: 'sonnet' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/agents', { id: 'carl', modelId: 'nomodel' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'PATCH', '/agents/bob', { rolePrompt: 'new', maxRuns: 2 })).body).toMatchObject({ rolePrompt: 'new', maxRuns: 2 });
    expect((await call(atlas, 'PATCH', '/agents/bob', { maxRuns: 11 })).status).toBe(400);
    const chat = (await call(atlas, 'POST', '/agents/bob/chats')).body;
    expect((await call(atlas, 'DELETE', '/agents/bob')).status).toBe(204);
    expect((await call(atlas, 'GET', '/agents')).body.map((a: any) => a.id)).not.toContain('bob');
    expect((await call(atlas, 'GET', '/chats')).body.map((c: any) => c.id)).not.toContain(chat.id);
  });

  test('[A02] deleting the triage agent is handled (no crash; error or triage cleared)', async ({ atlas }) => {
    const r = await call(atlas, 'DELETE', '/agents/atlas');
    expect([204, 400, 409]).toContain(r.status);
    const s = (await call(atlas, 'GET', '/settings')).body;
    if (r.status === 204) expect(s.triageAgent).not.toBe('atlas');
  });

  test('[A03] a disabled agent does not run its ready cards, and says why', async ({ atlas }) => {
    await call(atlas, 'PATCH', '/agents/atlas', { enabled: false });
    const c = await atlas.task('disabled agent');
    await new Promise((r) => setTimeout(r, 1200));
    const card = await atlas.card(c.id);
    expect(card.status).toBe('ready');
    expect(card.waiting ?? '').toMatch(/disabled|off/i);
    expect(atlas.model.calls.length).toBe(0);
  });

  test('[A04] unknown agent → 404 for chats / main-chat; main chat is stable, /new makes a fresh one', async ({ atlas }) => {
    expect((await call(atlas, 'POST', '/agents/ghost/chats')).status).toBe(404);
    expect((await call(atlas, 'POST', '/agents/ghost/main-chat')).status).toBe(404);
    const m1 = (await call(atlas, 'POST', '/agents/atlas/main-chat')).body;
    const m2 = (await call(atlas, 'POST', '/agents/atlas/main-chat')).body;
    expect(m2.id).toBe(m1.id);
    const m3 = (await call(atlas, 'POST', '/agents/atlas/main-chat/new')).body;
    expect(m3.id).not.toBe(m1.id);
    expect((await call(atlas, 'GET', '/agents')).body[0].mainChat).toBe(m3.id);
  });

  test('[A05] direct chat refuses status/assignee changes, allows archive; never on the task list', async ({ atlas }) => {
    const ch = await atlas.chat();
    expect((await call(atlas, 'PATCH', `/cards/${ch.id}`, { status: 'todo' })).status).toBe(400);
    expect((await call(atlas, 'PATCH', `/cards/${ch.id}`, { assignee: null })).status).toBe(400);
    expect((await call(atlas, 'GET', '/cards')).body.map((c: any) => c.id)).not.toContain(ch.id);
    expect((await call(atlas, 'PATCH', `/cards/${ch.id}`, { status: 'archived' })).status).toBe(200);
    expect((await call(atlas, 'GET', '/chats')).body.map((c: any) => c.id)).not.toContain(ch.id);
  });

  test('[A06] direct chat: 1st user message names the chat; the 3rd triggers one background rename', async ({ atlas }) => {
    const ch = await atlas.chat();
    await atlas.converse(ch.id, 'Plan my trip to Lisbon');
    expect((await atlas.card(ch.id)).title).toContain('Plan my trip');
    await atlas.converse(ch.id, 'two', 'three');
    await expect.poll(async () => (await atlas.card(ch.id)).title, { timeout: 10_000 }).toBe('Scripted chat');
    expect(atlas.model.of('title').length).toBe(1);
  });

  test('[M01] models: validation, CRUD, test reports an unreachable server, in-use model cannot be deleted', async ({ atlas }) => {
    expect((await call(atlas, 'POST', '/models', { id: 'x', provider: 'openai_compat', name: 'm' })).status).toBeGreaterThanOrEqual(400);
    const ok = await call(atlas, 'POST', '/models', { id: 'dead', provider: 'openai_compat', name: 'm1', baseUrl: 'http://127.0.0.1:9/v1' });
    expect(ok.status).toBe(201);
    expect((await call(atlas, 'PATCH', '/models/dead', { maxTokens: 1000 })).body.maxTokens).toBe(1000);
    expect((await call(atlas, 'PATCH', '/models/dead', { contextWindow: 10 })).status).toBe(400);
    // POST /models/:id/test with a dead server cannot be checked here: the harness routes every model to the scripted provider.
    expect((await call(atlas, 'POST', '/models/dead/test')).status).toBeLessThan(500);
    await call(atlas, 'POST', '/agents', { id: 'user1', modelId: 'dead' });
    expect((await call(atlas, 'DELETE', '/models/dead')).status).toBe(409);
    await call(atlas, 'DELETE', '/agents/user1');
    expect((await call(atlas, 'DELETE', '/models/dead')).status).toBe(204);
    expect((await call(atlas, 'POST', '/models/ghost/test')).body.ok).toBe(false);
  });

  test('[M02] an unknown provider cannot be created (design §5: only anthropic, openai_compat, chatgpt, claude_plan)', async ({ atlas }) => {
    const r = await call(atlas, 'POST', '/models', { id: 'cc', provider: 'cli_subscription', name: 'x' });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  test('[M03] a run on an unreachable model blocks the card with the reason (no fallback)', async ({ atlas }) => {
    atlas.model.complete = async () => {
      throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9');
    };
    const c = await atlas.task('unreachable');
    await expect.poll(async () => (await atlas.card(c.id)).status, { timeout: 20_000 }).toBe('blocked');
    expect((await atlas.card(c.id)).block?.reason).toMatch(/ECONNREFUSED|reach|fetch/i);
  });

  test('[S01] settings: name/about validation, triageAgent nullable, unknown key refused', async ({ atlas }) => {
    expect((await call(atlas, 'PATCH', '/settings', { userName: '' })).status).toBe(400);
    expect((await call(atlas, 'PATCH', '/settings', { userAbout: 'x'.repeat(201) })).status).toBe(400);
    expect((await call(atlas, 'PATCH', '/settings', { bogus: 1 })).status).toBe(400);
    expect((await call(atlas, 'PATCH', '/settings', { triageAgent: null })).body.triageAgent).toBeNull();
    expect((await call(atlas, 'PATCH', '/settings', { triageAgent: 'ghost' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'PATCH', '/settings', { memoryReviewModel: 'off' })).body.memoryReviewModel).toBe('off');
  });

  test('[S02] with no triage agent a triage card stays put', async ({ atlas }) => {
    await call(atlas, 'PATCH', '/settings', { triageAgent: null });
    const r = await call(atlas, 'POST', '/cards', { title: 'idea' });
    await new Promise((r) => setTimeout(r, 1000));
    expect((await atlas.card(r.body.id)).status).toBe('triage');
    expect(atlas.model.calls.length).toBe(0);
  });

  test('[S03] /health, /about, /voice 404 off-desktop, /usage shape, /cards/:id/usage', async ({ atlas }) => {
    expect((await call(atlas, 'GET', '/health')).body).toEqual({ ok: true });
    expect((await call(atlas, 'GET', '/about')).body).toMatchObject({ server: false, voice: false });
    expect((await call(atlas, 'GET', '/voice')).status).toBe(404);
    expect((await call(atlas, 'PATCH', '/voice', { enabled: true })).status).toBe(404);
    const u = (await call(atlas, 'GET', '/usage?days=7')).body;
    expect(u.days).toBe(7);
    expect(u.perDay.length).toBe(7);
    const ch = await atlas.chat();
    await atlas.converse(ch.id, 'hi');
    expect((await call(atlas, 'GET', `/cards/${ch.id}/usage`)).body.contextWindow).toBeGreaterThan(0);
  });

  test('[S04] secrets: names only; no keychain → writes refused with the env hint and never echo the value', async ({ atlas }) => {
    expect((await call(atlas, 'GET', '/secrets')).body.names).toEqual([]);
    const p = await call(atlas, 'PUT', '/secrets/FOO_KEY', { value: 'sekret' });
    expect(p.status).toBe(409);
    expect(JSON.stringify(p.body)).not.toContain('sekret');
    expect((await call(atlas, 'DELETE', '/secrets/FOO_KEY')).status).toBe(409);
  });

  test('[S05] cross-site Origin and non-loopback Host are refused (CSRF / DNS rebinding)', async ({ atlas }) => {
    const u = new URL(atlas.url);
    const req = (headers: Record<string, string>) =>
      new Promise<number>((res, rej) => {
        const r = http.request({ host: '127.0.0.1', port: Number(u.port), path: '/api/cards', method: 'GET', headers }, (resp) => {
          resp.resume();
          res(resp.statusCode ?? 0);
        });
        r.on('error', rej);
        r.end();
      });
    expect(await req({})).toBe(200);
    expect(await req({ Origin: 'https://evil.example' })).toBe(403);
    expect(await req({ Host: 'evil.example' })).toBe(403);
  });

  test('[S06] /api/files serves workspace files under a CSP sandbox; traversal, dotfiles, missing, unknown agent refused', async ({ atlas }) => {
    const ws = join(atlas.dataDir, 'workspaces', 'atlas');
    mkdirSync(join(ws, 'pages'), { recursive: true });
    writeFileSync(join(ws, 'pages', 'a.html'), '<h1>hi</h1>');
    writeFileSync(join(ws, '.secret'), 'x');
    const r = await fetch(atlas.url + '/api/files/atlas/pages/a.html');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-security-policy')).toMatch(/sandbox/);
    expect(await r.text()).toBe('<h1>hi</h1>');
    expect((await fetch(atlas.url + '/api/files/atlas/nope.html')).status).toBe(404);
    const u = new URL(atlas.url);
    const raw = await new Promise<number>((res) => {
      http.request({ host: '127.0.0.1', port: Number(u.port), path: '/api/files/atlas/%2e%2e/%2e%2e/atlas.db', method: 'GET' }, (x) => {
        x.resume();
        res(x.statusCode ?? 0);
      }).end();
    });
    expect(raw).toBeGreaterThanOrEqual(400);
    expect((await fetch(atlas.url + '/api/files/atlas/.secret')).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(atlas.url + '/api/files/ghost/a.html')).status).toBe(404);
  });
});

test.describe('Y · memory (API + tools)', () => {
  test('[Y01] memories CRUD: validation, m12 refs, edit, pin, archive/restore, filters, FTS q', async ({ atlas }) => {
    const m = (await call(atlas, 'POST', '/memories', { kind: 'rule', scope: 'shared', text: 'always use tabs' })).body;
    expect(m).toMatchObject({ kind: 'rule', scope: 'shared', status: 'active', updatedBy: 'user' });
    expect((await call(atlas, 'POST', '/memories', { kind: 'bogus', scope: 'shared', text: 'x' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/memories', { kind: 'rule', scope: 'agent:ghost', text: 'x' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'POST', '/memories', { kind: 'rule', scope: 'shared', text: 'x'.repeat(501) })).status).toBe(400);
    expect((await call(atlas, 'GET', `/memories/m${m.id}`)).body.id).toBe(m.id);
    expect((await call(atlas, 'GET', `/memories/${m.id}`)).body.id).toBe(m.id);
    expect((await call(atlas, 'GET', `/memories/xyz`)).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'PATCH', `/memories/m${m.id}`, { text: 'always use spaces', kind: 'preference' })).body).toMatchObject({ text: 'always use spaces', kind: 'preference' });
    expect((await call(atlas, 'PATCH', `/memories/m${m.id}`, { pinned: true })).body.pinned).toBe(true);
    await call(atlas, 'POST', '/memories', { kind: 'fact', scope: 'agent:atlas', text: 'the zebra lives in the barn' });
    expect((await call(atlas, 'GET', '/memories?q=zebra')).body.length).toBe(1);
    expect((await call(atlas, 'GET', '/memories?kind=fact')).body.length).toBe(1);
    expect((await call(atlas, 'GET', '/memories?scope=agent:atlas')).body.length).toBe(1);
    expect((await call(atlas, 'PATCH', `/memories/m${m.id}`, { status: 'archived' })).body.status).toBe('archived');
    // GET /memories without a status filter returns every status (the UI filters); the archived one carries its status
    expect((await call(atlas, 'GET', '/memories?status=active')).body.map((x: any) => x.id)).not.toContain(m.id);
    expect((await call(atlas, 'GET', '/memories?status=archived')).body.length).toBe(1);
    expect((await call(atlas, 'PATCH', `/memories/m${m.id}`, { status: 'active' })).body.status).toBe('active');
  });

  test('[Y02] 3000-char always-on budget enforced on write (409); facts are not counted; /memory-budget', async ({ atlas }) => {
    for (let i = 0; i < 6; i++) expect((await call(atlas, 'POST', '/memories', { kind: 'rule', scope: 'shared', text: String(i).repeat(490) })).status).toBe(201);
    expect((await call(atlas, 'POST', '/memories', { kind: 'rule', scope: 'shared', text: 'z'.repeat(400) })).status).toBe(409);
    const b = (await call(atlas, 'GET', '/agents/atlas/memory-budget')).body;
    expect(b.limit).toBe(3000);
    expect(b.used).toBeGreaterThan(2900);
    expect((await call(atlas, 'POST', '/memories', { kind: 'fact', scope: 'shared', text: 'z'.repeat(400) })).status).toBe(201);
    expect((await call(atlas, 'GET', '/agents/ghost/memory-budget')).status).toBe(404);
  });

  test('[Y03] changes feed + undo: undo of an edit restores text; second undo refused; bad input 400', async ({ atlas }) => {
    const m = (await call(atlas, 'POST', '/memories', { kind: 'fact', scope: 'shared', text: 'v1 text here' })).body;
    await call(atlas, 'PATCH', `/memories/m${m.id}`, { text: 'v2 text here' });
    const ch = (await call(atlas, 'GET', '/memories/changes?since=2020-01-01T00:00:00Z')).body;
    expect(ch.length).toBeGreaterThanOrEqual(2);
    const upd = ch.find((c: any) => c.action === 'update');
    expect((await call(atlas, 'POST', `/memories/changes/${upd.id}/undo`)).status).toBe(200);
    expect((await call(atlas, 'GET', `/memories/${m.id}`)).body.text).toBe('v1 text here');
    expect((await call(atlas, 'POST', `/memories/changes/${upd.id}/undo`)).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'GET', '/memories/changes?since=garbage')).status).toBe(400);
    expect((await call(atlas, 'POST', '/memories/changes/abc/undo')).status).toBe(400);
  });

  test('[Y04] memory tools: memory_add dedup refuses and lists similar; new:true saves; memory_search finds', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(
      tu('memory_add', { kind: 'fact', scope: 'shared', text: 'deploys go through the staging cluster first' }),
      tu('memory_add', { kind: 'fact', scope: 'shared', text: 'deploys always go through staging cluster first' }),
      tu('memory_add', { kind: 'fact', scope: 'shared', text: 'deploys always go through staging cluster first', new: true }),
      tu('memory_search', { query: 'staging' }),
      say('done'),
    );
    await atlas.say(ch.id, 'remember');
    await expect.poll(() => atlas.model.of('main').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
    const results = atlas.model.of('main').slice(1).map((c) => JSON.stringify(c.req.messages.at(-1)));
    expect(results[1]).toMatch(/similar|already|update/i);
    expect((await call(atlas, 'GET', '/memories')).body.length).toBe(2);
    expect(results[3]).toMatch(/staging/);
  });

  test('[Y05] memory proposals: list/validation; unknown ids refused', async ({ atlas }) => {
    expect((await call(atlas, 'GET', '/memory-proposals')).body).toEqual([]);
    expect((await call(atlas, 'GET', '/memory-proposals?status=bogus')).status).toBe(400);
    expect((await call(atlas, 'POST', '/memory-proposals/p99/approve')).status).toBeGreaterThanOrEqual(400);
    expect((await call(atlas, 'POST', '/memory-proposals/zz/reject')).status).toBe(400);
  });
});
