import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@atlas/shared';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest } from './providers/types.ts';
import { PROJECT_FILE_CAP, projectInstructions } from './runner.ts';

let engines: Engine[] = [];
afterEach(async () => {
  for (const e of engines) await e.stop().catch(() => {});
  engines = [];
});

async function setup(fake: FakeProvider, dbFile = ':memory:', dataDir = mkdtempSync(join(tmpdir(), 'atlas-'))) {
  const engine = await startEngine({ dbFile, dataDir, port: 0, dispatch: false, providers: () => fake, env: {} });
  engines.push(engine);
  return { engine, dataDir };
}

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const lastText = (req: ModelRequest) =>
  req.messages.at(-1)!.content.flatMap((b) => (b.type === 'text' ? [b.text] : b.type === 'tool_result' ? [b.content] : [])).join('\n');

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('background shell', () => {
  it('starts, reads output, and wakes the agent with an exit note', async () => {
    let id = '';
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'echo hi; sleep 0.4; echo bye; exit 4', background: true } }],
      (req) => {
        id = /started (bg_\w+)/.exec(lastText(req))![1]!;
        return [{ type: 'tool_use', id: 't2', name: 'shell_output', input: { id } }];
      },
      text('Started; waiting for it.'),
      text('It ended with code 4.'),
    ]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'bg', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('run it in the background'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(lastText(fake.calls[2]!)).toMatch(new RegExp(`^${id}: running \\(pid \\d+`));
    expect(engine.runner.background.get(id)!.status).toBe('running');

    await until(() => fake.calls.length === 4);
    await engine.runner.settled(card.id);
    const note = lastText(fake.calls[3]!);
    expect(note).toContain(`Background process ${id} (\`echo hi; sleep 0.4; echo bye; exit 4\`) exited with code 4.`);
    expect(note).toMatch(/hi\nbye\n```$/);
    expect(engine.kanban.messages(card.id).at(-2)!.author).toBe('system');
    expect(engine.runner.background.get(id)).toMatchObject({ status: 'exited', exitCode: 4 });
    // Reading after the end: status + nothing new.
    expect(engine.runner.background.read(id, 'atlas')).toMatch(/bye\n$/); // the rest since shell_output
    expect(engine.runner.background.read(id, 'atlas')).toMatch(/exited with code 4\n\(no new output; 7 bytes in total\)/);
    expect(engine.runner.background.read(id, 'atlas', 3)).toContain('bye');
    expect(() => engine.runner.background.read(id, 'someone-else')).toThrow(/no background process/);
  });

  it('shell_kill stops the process tree without an exit note', async () => {
    const fake = new FakeProvider([
      [{ type: 'tool_use', id: 't1', name: 'shell', input: { command: 'sleep 30', background: true } }],
      text('ok'),
    ]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'bg', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('go'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const [p] = engine.runner.background.running();
    expect(engine.runner.background.kill(p!.id, 'atlas')).toMatch(/sent SIGTERM/);
    await until(() => engine.runner.background.get(p!.id)!.status !== 'running');
    expect(engine.runner.background.get(p!.id)!.status).toBe('killed');
    expect(alive(p!.pid!)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls).toHaveLength(2); // no wake
  });

  it('kills and reports processes of a dead engine at restart, and kills its own at shutdown', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const dbFile = join(dataDir, 'bg.db');
    const first = await setup(new FakeProvider([]), dbFile, dataDir);
    const card = first.engine.kanban.create({ title: 'bg', assignee: 'atlas' }, 'user');
    const p = first.engine.runner.background.start({ command: 'sleep 30', cwd: dataDir, logDir: join(dataDir, 'outputs/atlas'), agentId: 'atlas', cardId: card.id });
    expect(alive(p.pid!)).toBe(true);
    // The first engine "dies": its lease is never renewed.
    first.engine.db.prepare("UPDATE background_processes SET lease_until = '2000-01-01T00:00:00Z'").run();

    const fake = new FakeProvider([text('Noted: it was lost in the restart.')]);
    const second = await setup(fake, dbFile, dataDir);
    expect(second.engine.runner.background.get(p.id)).toMatchObject({ status: 'lost' });
    await until(() => !alive(p.pid!));
    await until(() => fake.calls.length === 1);
    expect(lastText(fake.calls[0]!)).toContain(`Background process ${p.id} (\`sleep 30\`) lost: the engine stopped while it ran`);

    // Graceful shutdown kills the engine's own processes.
    const q = second.engine.runner.background.start({ command: 'sleep 30', cwd: dataDir, logDir: join(dataDir, 'outputs/atlas'), agentId: 'atlas', cardId: card.id });
    await second.engine.runner.settled(card.id);
    await second.engine.stop();
    engines = engines.filter((e) => e !== second.engine);
    await until(() => !alive(q.pid!));
    const third = await setup(new FakeProvider([]), dbFile, dataDir);
    expect(third.engine.runner.background.get(q.id)).toMatchObject({ status: 'killed' });
  });
});

describe('provider web search in the loop', () => {
  it('asks for web search, continues a paused turn, and keeps the server blocks in the transcript', async () => {
    const search: ContentBlock = { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'atlas' } };
    const result: ContentBlock = { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', url: 'https://ex.com', title: 'Ex', encrypted_content: 'e' }] };
    const fake = new FakeProvider([[search], [result, { type: 'text', text: 'Ex says hi.' }]]);
    const { engine } = await setup(fake);
    const card = engine.kanban.create({ title: 'web', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('search'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    expect(fake.calls[0]!.webSearch).toBe(true);
    // pause_turn: the second call continues the answer (the view ends with the assistant's paused turn).
    expect(fake.calls[1]!.messages.at(-1)).toEqual({ role: 'assistant', content: [search] });
    expect(engine.kanban.messages(card.id).flatMap((m) => m.content.map((b) => b.type))).toEqual(['text', 'server_tool_use', 'web_search_tool_result', 'text']);
    expect(engine.runner.runs(card.id)[0]!.status).toBe('done');
  });
});

describe('project instructions', () => {
  it('puts AGENTS.md and CLAUDE.md from the workdir in the system prompt, labelled and capped', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-'));
    const wd = join(dataDir, 'workspaces/atlas');
    mkdirSync(wd, { recursive: true });
    writeFileSync(join(wd, 'AGENTS.md'), 'Use pnpm here.');
    writeFileSync(join(wd, 'CLAUDE.md'), 'C'.repeat(PROJECT_FILE_CAP + 500));
    const fake = new FakeProvider([text('ok')]);
    const { engine } = await setup(fake, ':memory:', dataDir);
    const card = engine.kanban.create({ title: 'p', assignee: 'atlas' }, 'user');
    engine.kanban.appendMessage(card.id, 'user', 'user', text('hi'));
    engine.runner.wake(card.id);
    await engine.runner.settled(card.id);
    const system = fake.calls[0]!.system;
    expect(system).toContain(`# Project instructions\nFrom files in your working directory; follow them for work there.\n\n## ${join(wd, 'AGENTS.md')}\nUse pnpm here.\n\n## ${join(wd, 'CLAUDE.md')}\nCCC`);
    expect(system).toContain(`C\n[… cut: the file has ${PROJECT_FILE_CAP + 500} chars; read_file CLAUDE.md for the rest]`);
    // Before the card and the date (the per-conversation tail of the prompt).
    expect(system.indexOf('# Project instructions')).toBeLessThan(system.indexOf('# Current card'));
    expect(projectInstructions(mkdtempSync(join(tmpdir(), 'empty-')))).toEqual([]);
  });
});
