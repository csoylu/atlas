import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '../../harness/fixtures.ts';
import { call, idleCard, tu, say } from '../../harness/audit.ts';

test.describe('C · artifacts, documents, side panel', () => {
  test('[C01] artifact folders (#120): create, empty name 400, rename, move, pin, delete moves items to Unfiled; canvases API gone', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(tu('artifact_create', { kind: 'markdown', title: 'Folder doc', content: '# Folder doc' }), say('done'));
    await atlas.say(ch.id, 'make a doc');
    await expect.poll(async () => (await call(atlas, 'GET', '/documents')).body.length, { timeout: 15_000 }).toBe(1);
    const doc = (await call(atlas, 'GET', '/documents')).body[0];
    const f = await call(atlas, 'POST', '/folders', { name: 'Specs' });
    expect(f.status).toBe(201);
    expect((await call(atlas, 'POST', '/folders', { name: '' })).status).toBe(400);
    expect((await call(atlas, 'PATCH', `/folders/${f.body.id}`, { name: 'Designs' })).body.name).toBe('Designs');
    expect((await call(atlas, 'POST', `/documents/${doc.id}/move`, { folderId: f.body.id })).body.folderId).toBe(f.body.id);
    expect((await call(atlas, 'POST', `/documents/${doc.id}/pin`, { pinned: true })).body.pinned).toBe(true);
    expect((await call(atlas, 'POST', `/documents/${doc.id}/pin`, { pinned: 'yes' })).status).toBe(400);
    expect((await call(atlas, 'DELETE', `/folders/${f.body.id}`)).status).toBe(204);
    expect((await call(atlas, 'GET', `/documents/${doc.id}`)).body.folderId ?? null).toBeNull();
    expect((await call(atlas, 'GET', '/canvases')).status).toBe(404);
  });

  test('[C02] artifact tools (#120): artifact_create / artifact_update (one replacement = one version) / artifact_list / artifact_read', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(
      tu('artifact_create', { kind: 'html', title: 'Agent page', content: '<h1>One</h1>' }),
      tu('artifact_update', { path: 'pages/agent-page.html', old_text: 'One', new_text: 'Two' }),
      tu('artifact_list', {}),
      tu('artifact_read', { path: 'pages/agent-page.html' }),
      say('done'),
    );
    await atlas.say(ch.id, 'make a page');
    await expect.poll(() => atlas.model.of('main').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(5);
    const list = (await call(atlas, 'GET', '/documents')).body;
    expect(list.length).toBe(1);
    expect(list[0].kind).toBe('html');
    expect(list[0].version).toBe(2);
    expect(JSON.stringify(atlas.model.of('main').at(-1))).toContain('<h1>Two</h1>');
  });

  test('[C03] documents: write_file docs/x.md is indexed; an outside edit makes a version; restore writes the file back; pin validates', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(tu('write_file', { path: 'docs/plan.md', content: '# Plan\n\nv1\n\n## Part A\nalpha\n' }), say('written'));
    await atlas.say(ch.id, 'write a doc');
    await expect.poll(async () => (await call(atlas, 'GET', '/documents')).body.length, { timeout: 15_000 }).toBe(1);
    const d = (await call(atlas, 'GET', '/documents')).body[0];
    expect(d).toMatchObject({ kind: 'markdown', title: 'Plan' });
    const file = join(atlas.dataDir, 'workspaces', 'atlas', 'docs', 'plan.md');
    writeFileSync(file, '# Plan\n\nv2\n');
    expect((await call(atlas, 'GET', `/documents/${d.id}`)).body.content).toContain('v2');
    expect((await call(atlas, 'GET', `/documents/${d.id}/versions`)).body.length).toBe(2);
    expect((await call(atlas, 'GET', `/documents/${d.id}?version=1`)).body.content).toContain('v1');
    expect((await call(atlas, 'POST', `/documents/${d.id}/restore/1`)).status).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('v1');
    expect((await call(atlas, 'POST', `/documents/${d.id}/pin`, { pinned: true })).status).toBe(200);
    expect((await call(atlas, 'POST', `/documents/${d.id}/pin`, { pinned: 'yes' })).status).toBe(400);
    expect((await call(atlas, 'GET', '/documents/nope')).status).toBe(404);
  });

  test('[C04] side panel: panel_open tool adds a tab, unknown section is refused listing sections, API focus/seen/close/open', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(
      tu('write_file', { path: 'docs/p.md', content: '# P\n\n## One\nx\n\n## Two\ny\n' }),
      tu('panel_open', { path: 'docs/p.md', section: 'Two' }),
      tu('panel_open', { path: 'docs/p.md', section: 'Nope' }),
      say('ok'),
    );
    await atlas.say(ch.id, 'show');
    await expect.poll(() => atlas.model.of('main').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
    const tabs = (await call(atlas, 'GET', `/chats/${ch.id}/panel`)).body;
    expect(tabs.length).toBe(1);
    expect(JSON.stringify(atlas.model.lastMain.req.messages.at(-1))).toMatch(/One/);
    const docId = tabs[0].docId ?? tabs[0].id ?? tabs[0].doc?.id;
    expect((await call(atlas, 'POST', `/chats/${ch.id}/panel/seen`, { docId })).status).toBe(200);
    expect((await call(atlas, 'POST', `/chats/${ch.id}/panel/focus`, { docId })).status).toBe(200);
    expect((await call(atlas, 'POST', `/chats/${ch.id}/panel/close`, { docId })).status).toBe(200);
    expect((await call(atlas, 'GET', `/chats/${ch.id}/panel`)).body.length).toBe(0);
    expect((await call(atlas, 'POST', `/chats/${ch.id}/panel/open`, { docId })).status).toBe(200);
    expect((await call(atlas, 'POST', `/chats/${ch.id}/panel/open`, { docId: 'zzz' })).status).toBe(404);
  });

  test('[C05] "Ask about this": a message with ref stores the ❝ quote first', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(tu('write_file', { path: 'docs/q.md', content: '# Q\n\n## Sec A\nthe quoted text\n' }), say('ok'));
    await atlas.say(ch.id, 'write');
    await expect.poll(async () => (await call(atlas, 'GET', '/documents')).body.length, { timeout: 15_000 }).toBe(1);
    await atlas.idle(ch.id);
    const d = (await call(atlas, 'GET', '/documents')).body[0];
    const doc = (await call(atlas, 'GET', `/documents/${d.id}`)).body;
    const sec = (doc.sections ?? [])[0]?.id ?? 'sec-a';
    atlas.model.next(say('answer'));
    const r = await call(atlas, 'POST', `/cards/${ch.id}/messages`, { text: 'explain', ref: { docId: d.id, version: 1, section: sec } });
    expect(r.status).toBe(201);
    expect(r.body.content[0].text).toMatch(/^❝/);
    expect(JSON.stringify(r.body.content)).toContain('the quoted text');
  });

  test('[C06] Library search (#120): titles and content across folders, a content match has a snippet', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(tu('artifact_create', { kind: 'markdown', title: 'Release notes', content: '# Release notes\n\nThe zebra crossing is fixed.' }), say('done'));
    await atlas.say(ch.id, 'notes');
    await expect.poll(async () => (await call(atlas, 'GET', '/documents')).body.length, { timeout: 15_000 }).toBe(1);
    const byTitle = (await call(atlas, 'GET', '/documents/search?q=release')).body;
    expect(byTitle.map((h: any) => h.doc.title)).toEqual(['Release notes']);
    const byBody = (await call(atlas, 'GET', '/documents/search?q=zebra')).body;
    expect(byBody[0].snippet).toContain('zebra');
    expect((await call(atlas, 'GET', '/documents/search?q=nothing-matches-this')).body).toEqual([]);
  });
});

test.describe('H · schedules, notifications', () => {
  test('[H01] schedule validation + preview', async ({ atlas }) => {
    const p = { agentId: 'atlas', prompt: 'ping' };
    expect((await call(atlas, 'POST', '/schedules', { ...p, kind: 'cron', cron: 'not a cron' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/schedules', { ...p, kind: 'cron' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/schedules', { ...p, kind: 'at' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/schedules', { ...p, kind: 'cron', cron: '0 9 * * *', timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await call(atlas, 'POST', '/schedules', { agentId: 'ghost', prompt: 'x', kind: 'cron', cron: '0 9 * * *' })).status).toBeGreaterThanOrEqual(400);
    const pv = await call(atlas, 'POST', '/schedules/preview', { kind: 'cron', cron: '0 9 * * 1-5', at: null, timezone: 'Europe/Paris' });
    expect(pv.body.next.length).toBe(3);
    expect((await call(atlas, 'POST', '/schedules/preview', { kind: 'cron', cron: '99 * * * *', at: null })).status).toBe(400);
  });

  test('[H02] schedule CRUD: title defaults to the prompt first line, patch, pause, kind switch needs a time, delete', async ({ atlas }) => {
    const s = (await call(atlas, 'POST', '/schedules', { agentId: 'atlas', prompt: 'Daily check\nmore', kind: 'cron', cron: '0 9 * * *', timezone: 'Europe/Paris' })).body;
    expect(s.title).toBe('Daily check');
    expect(s.nextRunAt).toBeTruthy();
    expect((await call(atlas, 'PATCH', `/schedules/${s.id}`, { enabled: false })).body.enabled).toBe(false);
    expect((await call(atlas, 'PATCH', `/schedules/${s.id}`, { cron: '0 10 * * *' })).body.cron).toBe('0 10 * * *');
    expect((await call(atlas, 'PATCH', `/schedules/${s.id}`, { kind: 'at' })).status).toBe(400);
    expect((await call(atlas, 'GET', `/schedules/${s.id}`)).status).toBe(200);
    expect((await call(atlas, 'DELETE', `/schedules/${s.id}`)).status).toBe(204);
    expect((await call(atlas, 'GET', `/schedules/${s.id}`)).status).toBe(404);
  });

  test('[H03] Run now: createCard=true makes a new card each time; false reuses the schedule chat card; Inbox update raised', async ({ atlas }) => {
    atlas.model.next(tu('task_complete', { summary: 's1' }), tu('task_complete', { summary: 's2' }), tu('task_complete', { summary: 's3' }), tu('task_complete', { summary: 's4' }));
    const a = (await call(atlas, 'POST', '/schedules', { agentId: 'atlas', prompt: 'make cards', kind: 'cron', cron: '0 9 * * *', createCard: true })).body;
    const r1 = await call(atlas, 'POST', `/schedules/${a.id}/run`);
    expect(r1.status).toBe(200);
    await expect.poll(async () => (await atlas.card(r1.body.id)).status).toBe('done');
    const r2 = await call(atlas, 'POST', `/schedules/${a.id}/run`);
    expect(r2.body.id).not.toBe(r1.body.id);
    await expect.poll(async () => (await atlas.card(r2.body.id)).status).toBe('done');
    const b = (await call(atlas, 'POST', '/schedules', { agentId: 'atlas', prompt: 'same card', kind: 'cron', cron: '0 9 * * *', createCard: false })).body;
    const q1 = await call(atlas, 'POST', `/schedules/${b.id}/run`);
    await expect.poll(async () => (await atlas.card(q1.body.id)).status).toBe('done');
    const q2 = await call(atlas, 'POST', `/schedules/${b.id}/run`);
    expect(q2.body.id).toBe(q1.body.id);
    expect((await call(atlas, 'POST', '/schedules/ghost/run')).status).toBe(404);
    expect(JSON.stringify((await call(atlas, 'GET', '/inbox')).body.updates)).toMatch(/make cards|same card/);
  });

  test('[H04] agent tools schedule_create / schedule_list / schedule_delete', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(
      tu('schedule_create', { prompt: 'tool made', cron: '30 8 * * 1-5', title: 'Tool schedule' }),
      tu('schedule_list', {}),
      say('ok'),
    );
    await atlas.say(ch.id, 'schedule');
    await expect.poll(() => atlas.model.of('main').length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
    const list = (await call(atlas, 'GET', '/schedules')).body;
    const mine = list.find((s: any) => s.title === 'Tool schedule');
    expect(mine).toBeTruthy();
    expect(mine.createdBy).toBe('atlas');
    expect(JSON.stringify(atlas.model.of('main')[2].req.messages.at(-1))).toContain('Tool schedule');
    atlas.model.next(tu('schedule_delete', { id: mine.id }), say('gone'));
    await atlas.say(ch.id, 'delete it');
    await expect.poll(async () => (await call(atlas, 'GET', '/schedules')).body.some((s: any) => s.id === mine.id), { timeout: 15_000 }).toBe(false);
  });

  test('[H05] seeded weekly Memory cleanup schedule: Monday 09:00, enabled, agent atlas', async ({ atlas }) => {
    expect((await call(atlas, 'GET', '/schedules/sch_memory_cleanup')).body).toMatchObject({ cron: '0 9 * * 1', enabled: true, agentId: 'atlas' });
  });

  test('[N01] notifications: read lowers the badge, archive-read, archive, bad id 400', async ({ atlas }) => {
    atlas.model.next(tu('task_complete', { summary: 'n1' }), tu('task_complete', { summary: 'n2' }));
    const c1 = await atlas.task('n1');
    await expect.poll(async () => (await atlas.card(c1.id)).status).toBe('done');
    const c2 = await atlas.task('n2');
    await expect.poll(async () => (await atlas.card(c2.id)).status).toBe('done');
    let ib = (await call(atlas, 'GET', '/inbox')).body;
    expect(ib.updates.length).toBe(2);
    const badge0 = ib.badge;
    expect((await call(atlas, 'POST', `/notifications/${ib.updates[0].id}/read`)).status).toBe(204);
    expect((await call(atlas, 'GET', '/inbox')).body.badge).toBe(badge0 - 1);
    expect((await call(atlas, 'POST', '/notifications/archive-read')).body.archived).toBe(1);
    ib = (await call(atlas, 'GET', '/inbox')).body;
    expect(ib.updates.length).toBe(1);
    expect((await call(atlas, 'POST', `/notifications/${ib.updates[0].id}/archive`)).status).toBe(204);
    expect((await call(atlas, 'GET', '/inbox')).body.updates).toEqual([]);
    expect((await call(atlas, 'POST', '/notifications/abc/read')).status).toBe(400);
  });

  test('[N02] a failed run raises an Inbox item with the error; a change made by the user raises none', async ({ atlas }) => {
    atlas.model.complete = async () => {
      throw new Error('boom 400 bad request');
    };
    const c = await atlas.task('fails');
    await expect.poll(async () => (await atlas.card(c.id)).status, { timeout: 20_000 }).toBe('blocked');
    expect(JSON.stringify((await call(atlas, 'GET', '/inbox')).body)).toContain('boom');
    const c2 = await idleCard(atlas, 'user moves');
    await call(atlas, 'PATCH', `/cards/${c2.id}`, { status: 'done' });
    expect(JSON.stringify((await call(atlas, 'GET', '/inbox')).body)).not.toContain('user moves');
  });
});

test.describe('R · rewind', () => {
  test('[R01] rewind preview/apply hides messages from the chat and from the model; undo brings them back', async ({ atlas }) => {
    const ch = await atlas.chat();
    await atlas.converse(ch.id, 'first message', 'second message');
    const msgs = (await call(atlas, 'GET', `/cards/${ch.id}/messages`)).body;
    const second = msgs.find((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('second message'));
    const pv = await call(atlas, 'GET', `/cards/${ch.id}/rewind?seq=${second.seq}`);
    expect(pv.status).toBe(200);
    expect(pv.body.hidden).toBeGreaterThanOrEqual(2);
    const rw = await call(atlas, 'POST', `/cards/${ch.id}/rewind`, { seq: second.seq });
    expect(rw.status).toBe(200);
    const after = (await call(atlas, 'GET', `/cards/${ch.id}/messages`)).body;
    expect(JSON.stringify(after)).not.toContain('second message');
    expect(JSON.stringify(after)).toContain('first message');
    const id = rw.body.id ?? rw.body.rewindId;
    expect(id).toBeTruthy();
    expect((await call(atlas, 'POST', `/rewinds/${id}/undo`)).status).toBe(200);
    expect(JSON.stringify((await call(atlas, 'GET', `/cards/${ch.id}/messages`)).body)).toContain('second message');
    expect((await call(atlas, 'GET', `/cards/${ch.id}/rewind?seq=abc`)).status).toBe(400);
    expect((await call(atlas, 'POST', `/rewinds/nope/undo`)).status).toBeGreaterThanOrEqual(400);
  });

  test('[R02] rewind restores files the turn wrote (workspace snapshot)', async ({ atlas }) => {
    const ch = await atlas.chat();
    atlas.model.next(say('hi'));
    await atlas.converse(ch.id, 'hello');
    const file = join(atlas.dataDir, 'workspaces', 'atlas', 'note.txt');
    atlas.model.next(tu('write_file', { path: 'note.txt', content: 'created by turn 2' }), say('wrote it'));
    await atlas.say(ch.id, 'write the file');
    await atlas.idle(ch.id);
    expect(readFileSync(file, 'utf8')).toContain('created by turn 2');
    const msgs = (await call(atlas, 'GET', `/cards/${ch.id}/messages`)).body;
    const m = msgs.find((x: any) => x.role === 'user' && JSON.stringify(x.content).includes('write the file'));
    const pv = (await call(atlas, 'GET', `/cards/${ch.id}/rewind?seq=${m.seq}`)).body;
    expect(pv.filesError ?? null).toBeNull();
    expect(pv.files.map((f: any) => f.path)).toContain('note.txt');
    await call(atlas, 'POST', `/cards/${ch.id}/rewind`, { seq: m.seq });
    expect(() => readFileSync(file, 'utf8')).toThrow();
  });
});

test.describe('P · providers and plan accounts (safe paths only)', () => {
  test('[P01] Anthropic accounts: keys never returned; unknown id 404', async ({ atlas }) => {
    const a = await call(atlas, 'POST', '/accounts', { label: 'Main', key: 'sk-ant-secretsecret' });
    if (a.status === 201) {
      expect(JSON.stringify(a.body)).not.toContain('secretsecret');
      expect(JSON.stringify((await call(atlas, 'GET', '/accounts')).body)).not.toContain('secretsecret');
      expect((await call(atlas, 'PATCH', `/accounts/${a.body.id}`, { label: 'Renamed' })).status).toBe(200);
      expect((await call(atlas, 'DELETE', `/accounts/${a.body.id}`)).status).toBe(204);
    } else expect([400, 409]).toContain(a.status);
    expect((await call(atlas, 'DELETE', '/accounts/ghost')).status).toBe(404);
  });

  test('[P02] plan subscriptions on a server engine: status explains, nothing returns 500', async ({ atlas }) => {
    expect((await call(atlas, 'GET', '/claude')).body.available).toBe(false);
    expect((await call(atlas, 'GET', '/chatgpt')).body.available).toBe(false);
    for (const [m, p, b] of [
      ['POST', '/claude/login', {}],
      ['POST', '/chatgpt/login', {}],
      ['POST', '/claude/complete', { code: 'bogus' }],
      ['POST', '/plan-accounts', { provider: 'claude_plan', label: 'Work' }],
      ['PUT', '/plan-accounts/order', { provider: 'claude_plan', ids: [] }],
      ['DELETE', '/plan-accounts/ghost', undefined],
    ] as const) {
      const r = await call(atlas, m, p, b);
      expect(r.status, `${m} ${p}`).toBeLessThan(500);
    }
    expect((await call(atlas, 'POST', '/plan-accounts', { provider: 'nope', label: 'x' })).status).toBe(400);
    expect((await call(atlas, 'PATCH', '/claude', { welcomed: true })).status).toBe(200);
    expect((await call(atlas, 'PATCH', '/claude', { bogus: 1 })).status).toBe(400);
  });

  test('[P03] local (Ollama) read paths only: GET /local and /local/models answer; /local/use needs a name (nothing is started, pulled or stopped)', async ({ atlas }) => {
    expect((await call(atlas, 'GET', '/local')).status).toBe(200);
    expect((await call(atlas, 'GET', '/local/models')).status).toBeLessThan(500);
    expect((await call(atlas, 'POST', '/local/use', {})).status).toBe(400);
    expect((await call(atlas, 'PATCH', '/local', { bogus: 1 })).status).toBe(400);
  });
});
