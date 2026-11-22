import { describe, expect, it } from 'vitest';
import { commandCore, duration, splitPath, toolRow } from './toolRows.ts';

const ok = (content: string) => ({ content, isError: false });
const err = (content: string) => ({ content, isError: true });

// Real inputs and results from the Atlas DB (tool_calls, 14 Nov 2026).
describe('toolRow', () => {
  it('files', () => {
    expect(toolRow('read_file', { path: 'packages/ui/src/ChatRow.tsx' }, ok('  1|import x\n  2|\n 48|end\n[showing lines 1–48 of 59; use offset=49 to continue]'))).toMatchObject({
      icon: 'read', verb: 'Read', running: 'Reading', dir: 'packages/ui/src/', object: 'ChatRow.tsx', rest: 'lines 1–48', detail: 'code', weight: 'read',
    });
    expect(toolRow('edit_file', { path: 'a/styles.css', old_text: 'a\nb\nc', new_text: 'a\nB\nc\nd' }, ok('edited a/styles.css'))).toMatchObject({
      verb: 'Edited', object: 'styles.css', add: 2, del: 1, meta: [{ add: 2, del: 1 }], detail: 'diff', weight: 'edit', short: { verb: 'edited', obj: 'styles.css' },
    });
    expect(toolRow('write_file', { path: 'docs/x.md', content: 'a\nb\n' }, ok('wrote 4 chars to docs/x.md'))).toMatchObject({ verb: 'Wrote', add: 2, del: 0 });
    expect(toolRow('grep', { pattern: 'chat-row', path: 'packages/ui/src/styles.css' }, ok('styles.css:12:.chat-row {\nstyles.css:40:.chat-row-line'))).toMatchObject({
      verb: 'Searched', object: '“chat-row”', mono: true, rest: 'in packages/ui/src/styles.css', meta: [{ text: '2 matches' }],
    });
    expect(toolRow('grep', { pattern: 'x', mode: 'files' }, ok('a.ts\nb.ts\nc.ts')).meta).toEqual([{ text: '3 files' }]);
    expect(toolRow('grep', { pattern: 'x' }, ok('no matches')).meta).toEqual([{ text: '0 matches' }]);
    expect(toolRow('glob', { pattern: 'packages/ui/src/*.tsx' }, ok('a.tsx\nb.tsx'))).toMatchObject({ verb: 'Found', object: '2 files', rest: 'packages/ui/src/*.tsx' });
    expect(toolRow('list_files', { path: 'packages/engine/src/providers' }, ok('a\nb\nc'))).toMatchObject({ verb: 'Listed', object: 'providers', meta: [{ text: '3 entries' }] });
  });

  it('shell: exit pill and tone, background, output, kill', () => {
    expect(toolRow('shell', { command: 'npm test\n# more' }, ok('exit 0\nok'))).toMatchObject({ icon: 'term', tone: 'ok', verb: 'Ran', object: 'npm test', mono: true, meta: [{ pill: 'ok', text: 'exit 0' }], weight: 'shell' });
    expect(toolRow('shell', { command: 'false' }, ok('exit 1\n'))).toMatchObject({ tone: 'bad', meta: [{ pill: 'bad', text: 'exit 1' }] });
    expect(toolRow('shell', { command: 'npm run dev', background: true }, ok('started bg_158be270 in the background (pid 1)'))).toMatchObject({ icon: 'bg', verb: 'Started in background', meta: [{ text: 'bg_158b' }] });
    expect(toolRow('shell', { command: 'sleep 9' })).toMatchObject({ running: 'Running', meta: [] });
    expect(toolRow('shell_output', { id: 'bg_831f7700' }, ok('bg_831f7700: running (pid 62925, since …)'))).toMatchObject({ verb: 'Checked', meta: [{ text: 'running' }] });
    expect(toolRow('shell_kill', { id: 'bg_1' }, ok('sent SIGTERM to bg_1 (pid 2); its log stays at x'))).toMatchObject({ verb: 'Stopped', rest: 'SIGTERM · log kept' });
  });

  it('cards and team', () => {
    expect(toolRow('card_create', { title: 'Rewind bug' }, ok('created #68 [ready] @atlas P1 Rewind must only restore files'))).toMatchObject({
      icon: 'cardp', tone: 'acc', verb: 'Created', ref: '#68', object: 'Rewind must only restore files', meta: [{ text: '@atlas · Low' }],
    });
    expect(toolRow('card_update', { id: 58, status: 'ready' }, ok('updated #58 [ready] @atlas P2 Chat: compact'))).toMatchObject({ verb: 'Updated', ref: '#58', object: 'Chat: compact', rest: 'status → ready' });
    expect(toolRow('card_update', { id: '#58', priority: 1, assignee: 'atlas', body: 'x' }).rest).toBe('priority → Low, assignee → @atlas, body');
    expect(toolRow('card_create', { title: 'X' }, ok('created #9 [todo] @atlas P2 Child (parents: #7, #8)'))).toMatchObject({ ref: '#9', object: 'Child' });
    expect(toolRow('card_create', { title: 'X' }, err('unknown parent #99'))).toMatchObject({ ref: undefined, object: 'X', tone: 'bad', verb: 'Couldn’t create' });
    expect(toolRow('card_message', { id: 57, text: '#56: done.\nmore' }, ok('message posted on #57'))).toMatchObject({ verb: 'Messaged', ref: '#57', rest: '#56: done.' });
    expect(toolRow('card_show', { id: 56 }, ok('#56 [running] @atlas P2 Menu bar orb\n\nbody'))).toMatchObject({ verb: 'Looked at', ref: '#56', object: 'Menu bar orb', meta: [{ text: 'running' }] });
    expect(toolRow('card_list', {}, ok('#10 [done] unassigned P3 A\n#4 [done] unassigned P2 B'))).toMatchObject({ verb: 'Listed the board', meta: [{ text: '2 tasks' }] });
    expect(toolRow('card_list', {}, ok('#1 [running] @atlas P2 A\n#2 [ready] @atlas P2 B\n#3 [done] @atlas P2 C')).meta).toEqual([{ text: '3 tasks · 1 running · 1 ready' }]);
    expect(toolRow('card_list', { status: 'blocked' }, ok('(no cards)'))).toMatchObject({ rest: 'blocked tasks', meta: [{ text: '0 tasks' }] });
    expect(toolRow('card_block', { kind: 'needs_input', question: 'Which one?\nDetails' }, ok('card blocked'))).toMatchObject({ tone: 'warn', verb: 'Asked you', object: 'Which one?', rest: 'needs input' });
    expect(toolRow('card_request_review', { summary: 'Ready.', prs: ['https://github.com/csoylu/atlas/pull/41'] }, ok('in review'))).toMatchObject({ tone: 'plain', verb: 'Sent to QA', object: 'PR #41', rest: 'Ready.' });
    expect(toolRow('card_complete', { summary: '**Done** in `x`.' }, ok('card done'))).toMatchObject({ tone: 'ok', icon: 'check', verb: 'Finished the task', rest: 'Done in x.' });
    expect(toolRow('history_search', { query: 'mockup' }, ok('no message contains "mockup"'))).toMatchObject({ object: '“mockup”', meta: [{ text: '0 hits' }] });
    expect(toolRow('history_search', { seq: 50 }, ok('#50 tool …'))).toMatchObject({ object: 'message #50', meta: [] });
  });

  it('canvas, panel, memory, plan, schedules, web', () => {
    expect(toolRow('canvas_create', { name: '#59 Chat activity' }, ok('created cv_b8f5fc78'))).toMatchObject({ verb: 'Created canvas', object: '#59 Chat activity', meta: [{ text: 'cv_b8f5' }] });
    expect(toolRow('canvas_write', { id: 'cv_b8f5fc78', show: ['a'] }, ok('canvas cv_b8f5fc78 is now v2 with 2 nodes; shown inline: a'))).toMatchObject({ verb: 'Updated canvas', meta: [{ text: '2 nodes · v2' }] });
    expect(toolRow('canvas_read', { id: 'cv_1' }, ok('{"id":"cv_1","name":"Board","version":4,"nodes":[{},{}]}'))).toMatchObject({ object: 'Board', meta: [{ text: 'v4 · 2 nodes' }] });
    expect(toolRow('canvas_read', { id: 'cv_1' }, ok('not json'))).toMatchObject({ object: 'cv_1', meta: [] });
    expect(toolRow('canvas_list', {}, ok('cv_1 "a" v2\ncv_2 "b" v1'))).toMatchObject({ meta: [{ text: '2 canvases' }] });
    expect(toolRow('panel_open', { path: 'docs/chat-activity.md' }, ok('opened …'))).toMatchObject({ tone: 'acc', object: 'chat-activity.md', detail: 'doc' });
    expect(toolRow('memory_edit', { text: 'Voice: short', mode: 'append' }, ok('self memory saved (1513/4000 chars)'))).toMatchObject({ verb: 'Saved to memory', meta: [{ text: 'mine · 1513/4000' }] });
    expect(toolRow('memory_edit', { text: 'x', mode: 'replace', scope: 'shared' }, ok('shared memory saved'))).toMatchObject({ verb: 'Rewrote memory', meta: [{ text: 'shared' }] });
    expect(toolRow('memory_add', { kind: 'rule', text: 'Run tests' }, ok('saved m12 (rule, agent:atlas) · always-on 1509/3000 chars'))).toMatchObject({ verb: 'Saved to memory', rest: 'Run tests', meta: [{ text: 'rule · mine · m12 · 1509/3000' }] });
    expect(toolRow('memory_add', { kind: 'rule', text: 'x', update: 'm3' }, ok('updated m3 (rule, shared) · always-on 9/3000 chars'))).toMatchObject({ verb: 'Updated memory' });
    expect(toolRow('memory_add', { kind: 'rule', text: 'x' }, { isError: true, content: 'Nothing saved: similar memories exist.\n- [m1] y' })).toMatchObject({ verb: 'Couldn’t save to memory', rest: 'Nothing saved: similar memories exist.' });
    expect(toolRow('memory_search', { query: 'orb' }, ok('- [m1 · fact] a\n- [m2 · fact] b'))).toMatchObject({ verb: 'Searched memory', object: 'orb', meta: [{ text: '2 matches' }] });
    const plan = { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }, { content: 'C', status: 'pending' }] };
    expect(toolRow('todo_write', plan, ok('saved'))).toMatchObject({ verb: 'Plan', object: '1 of 3 done', rest: 'now: B', detail: 'checklist' });
    expect(toolRow('schedule_create', { title: 'Follow-up', at: '2026-11-14T18:55:00+01:00', prompt: 'x' }, ok('scheduled')).rest).toMatch(/^once · Sat 14 Nov \d\d:55$/);
    expect(toolRow('schedule_create', { title: 'Digest', cron: '0 9 * * 1-5', agent: 'atlas', prompt: 'x' }, ok('scheduled'))).toMatchObject({ object: '“Digest”', rest: 'cron 0 9 * * 1-5 · @atlas', detail: 'schedule' });
    expect(toolRow('schedule_list', {}, ok('sch_1 @atlas "a": once at x\nsch_2 @atlas "b": once at y'))).toMatchObject({ verb: 'Listed schedules', meta: [{ text: '2 schedules' }] });
    expect(toolRow('schedule_delete', { id: 'sch_1' }, ok('schedule sch_1 deleted'))).toMatchObject({ verb: 'Deleted schedule', object: 'sch_1' });
    expect(toolRow('panel_open', { path: 'docs/chat-activity.md' }, ok('opened Chat activity (doc_1, docs/chat-activity.md, v3) in the side panel'))).toMatchObject({ meta: [{ text: 'v3' }] });
    expect(toolRow('web_fetch', { url: 'https://www.electronjs.org/docs/latest/api/tray' }, ok('URL: x\nTitle: Tray | Electron\n\n' + 'x'.repeat(12000)))).toMatchObject({
      object: 'electronjs.org/docs/latest/api/tray', rest: 'Tray | Electron', meta: [{ text: '12k chars' }],
    });
    expect(toolRow('web_search', { query: 'electron tray' }, ok('Tray | Electron\n  https://e/1\nOther\n  https://e/2'))).toMatchObject({ verb: 'Searched the web', meta: [{ text: '2 results' }] });
    expect(toolRow('web_search', { query: 'q' }, ok('no results')).meta).toEqual([{ text: '0 results' }]);
    expect(toolRow('web_fetch', { url: 'https://example.com/private' }, err('HTTP 403 from https://example.com/private: Forbidden'))).toMatchObject({
      tone: 'bad', icon: 'x', verb: 'Couldn’t fetch', object: 'example.com/private', rest: 'HTTP 403', meta: [],
    });
    expect(toolRow('web_search', { query: 'q' }, err('web search failed: max_uses_exceeded'))).toMatchObject({ tone: 'bad', verb: 'Couldn’t search the web', object: '“q”', rest: 'max uses exceeded' });
  });

  it('every failure: red x, "Couldn’t …", the error’s first line, no counts', () => {
    const r = toolRow('edit_file', { path: 'a/b.css', old_text: 'x', new_text: 'y\nz' }, err('a/b.css exists and has not been read\nmore'));
    expect(r).toMatchObject({ tone: 'bad', icon: 'x', verb: 'Couldn’t edit', object: 'b.css', rest: 'a/b.css exists and has not been read', meta: [] });
    expect(r.add).toBeUndefined();
    expect(toolRow('panel_open', { path: 'x.md' }, err('no file')).verb).toBe('Couldn’t open');
    expect(toolRow('mystery', {}, err('boom')).verb).toBe('Couldn’t run mystery');
  });

  it('an unknown tool falls back to a generic row with its name', () => {
    expect(toolRow('frobnicate', { target: 'the thing\nmore', n: 3 }, ok('done'))).toMatchObject({ icon: 'wrench', verb: 'Called', object: 'frobnicate', mono: true, rest: 'the thing', detail: 'generic' });
    expect(toolRow('frobnicate', 'not an object')).toMatchObject({ object: 'frobnicate', rest: undefined });
  });

  it('screenshot: target, width and theme, page errors and refused writes (#133)', () => {
    const out = 'Screenshot of /?theme=dark#/board\nPage errors (2):\n  page error: x\n  console.error: y\nWrites refused (read-only):\n  POST /api/cards';
    expect(toolRow('screenshot', { target: '#/board', width: 390, theme: 'dark' }, ok(out))).toMatchObject({
      verb: 'Screenshot', object: '#/board', meta: [{ text: '390 px · dark' }, { text: '2 page errors' }, { text: 'writes refused' }],
    });
    expect(toolRow('screenshot', { target: 'pages/x.html' }, ok('Screenshot of /api/files/a/pages/x.html\nPage errors: none')).meta).toEqual([{ text: '1440 px' }]);
    expect(toolRow('screenshot', { target: '#/x' }, err('screenshot needs Google Chrome, which was not found'))).toMatchObject({ verb: 'Couldn’t take a screenshot' });
  });

  it('every tool the engine has gets its own row (not the generic one)', () => {
    const tools = ['read_file', 'write_file', 'edit_file', 'list_files', 'grep', 'glob', 'shell', 'shell_output', 'shell_kill', 'web_fetch', 'web_search', 'screenshot', 'card_create', 'card_update', 'card_message', 'card_show', 'card_list', 'card_block', 'card_request_review', 'card_complete', 'history_search', 'canvas_create', 'canvas_write', 'canvas_read', 'canvas_list', 'panel_open', 'panel_close', 'memory_edit', 'memory_add', 'memory_update', 'memory_forget', 'memory_search', 'todo_write', 'schedule_create', 'schedule_list', 'schedule_delete'];
    for (const t of tools) expect(toolRow(t, {}, ok('')).icon, t).not.toBe('wrench');
  });
});

describe('helpers', () => {
  it('commandCore drops the setup in front of a command', () => {
    expect(commandCore('export PATH=~/.nvm/bin:$PATH && npm run typecheck && npm test')).toBe('npm run typecheck && npm test');
    expect(commandCore('cd packages/ui/src; grep -n x a.ts')).toBe('grep -n x a.ts');
    expect(commandCore('DB=~/x.db; sqlite3 "$DB" "select 1"')).toBe('sqlite3 "$DB" "select 1"');
    expect(commandCore('npm test\nmore')).toBe('npm test');
    expect(commandCore('cd x')).toBe('cd x');
  });
  it('splitPath', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ dir: 'a/b/', name: 'c.ts' });
    expect(splitPath('c.ts')).toEqual({ dir: '', name: 'c.ts' });
    expect(splitPath('a/b/')).toEqual({ dir: 'a/', name: 'b/' });
  });
  it('write_file: Created / Rewrote from the engine detail, a rewrite counts its diff (#63)', () => {
    const input = { path: 'docs/x.md', content: 'a\nB\nc\n' };
    expect(toolRow('write_file', input, ok('wrote'), { kind: 'write', created: true, before: null })).toMatchObject({ verb: 'Created', add: 3, del: 0, detail: 'code', short: { verb: 'created', obj: 'x.md' } });
    expect(toolRow('write_file', input, ok('wrote'), { kind: 'write', created: false, before: 'a\nb\nc\n' })).toMatchObject({ verb: 'Rewrote', add: 1, del: 1, detail: 'diff' });
    // Previous text too big to keep: no diff, the new text.
    expect(toolRow('write_file', input, ok('wrote'), { kind: 'write', created: false, before: null })).toMatchObject({ verb: 'Rewrote', add: 3, del: 0, detail: 'code' });
  });
  it('edit_file: a real line diff, times the replacements (#63)', () => {
    expect(toolRow('edit_file', { path: 'a.ts', old_text: 'x\ny', new_text: 'x\nY' }, ok('edited a.ts (2 replacements)'), { kind: 'edit', lines: [3, 9] })).toMatchObject({ add: 2, del: 2 });
  });
  it('duration: nothing under a second', () => {
    expect(duration(900)).toBeNull();
    expect(duration(NaN)).toBeNull();
    expect(duration(4290)).toBe('4.2 s');
    expect(duration(42_000)).toBe('42 s');
    expect(duration(72_000)).toBe('1 m 12 s');
    expect(duration(3_720_000)).toBe('1 h 2 m');
  });
});

