import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test, expect } from '@playwright/test';
import type { Card, ContentBlock, Project } from '@atlas/shared';
import { TestAtlas } from '../harness/engine.ts';
import { Remotes } from '../harness/projects.ts';
import { MemStore, settle } from '../harness/secrets.ts';
import { call, say, tu } from '../harness/audit.ts';

/**
 * #218 — isolation audit between two projects, with canaries, both ways.
 *
 * Project A is « Atlas » (the oldest: agents keep their own workdirs), project B is « Datinel » (a clone per member).
 * Each project gets canaries in every place a project owns something: its CLAUDE.md, an always-on memory (rule) and a
 * searchable one (fact, agent scope), a secret (name and value), an artifact (title and body), a task, a chat message.
 * An agent that is in both projects (zurich) then works in the OTHER project — a task and a chat turn, calling every
 * tool that could read across (shell env, memory, artifacts, tasks, history, grep/list/glob, file tools on the other
 * workspace's absolute path) — and the audit looks for the first project's canaries in everything the provider was
 * sent (system prompt, messages, tool results, tool specs), in what was stored, and in the shell's environment.
 * A positive control runs the same script in the canaries' own project: every kind of canary must show up there,
 * so « not found » means « not reachable », never « the probe can't see it ».
 *
 * The probes never contain a canary: they search a prefix (« CANARY ») and use ids/paths, so a canary found in a
 * request is always one the engine put there.
 */
const DATA_ROOT = join(import.meta.dirname, '..', '.data'); // not under /tmp: file tools may read the OS temp folders
mkdirSync(DATA_ROOT, { recursive: true });

type Side = 'A' | 'B';
const canaries = (s: Side) => ({
  claude: `CANARY-${s}-CLAUDEMD-4f1c`,
  rule: `CANARY-${s}-MEMORY-RULE-77ab`,
  fact: `CANARY-${s}-MEMORY-FACT-0c9e`,
  secretName: `CANARY_${s}_SECRET_KEY_2D8F`,
  secretValue: `canary-${s}-secret-value-9a3b51e7`,
  artTitle: `CANARY-${s}-ARTIFACT-TITLE-5e21`,
  artBody: `CANARY-${s}-ARTIFACT-BODY-b60d`,
  taskTitle: `CANARY-${s}-TASK-TITLE-31fa`,
  taskBody: `CANARY-${s}-TASK-BODY-e4c8`,
  chat: `CANARY-${s}-CHAT-MESSAGE-8d70`,
});
type Canaries = ReturnType<typeof canaries>;
const values = (c: Canaries) => Object.values(c);

interface Side0 {
  side: Side;
  id: string; // project id
  c: Canaries;
  workspace: string; // zurich's workspace there
  docId: string;
  taskId: string;
}

interface World {
  atlas: TestAtlas;
  remotes: Remotes;
  store: MemStore;
  A: Side0;
  B: Side0;
  cleanup(): Promise<void>;
}

const MAIN_PROJECTS = { A: 'atlas', B: 'datinel' } as const;

async function world(): Promise<World> {
  const remotes = new Remotes();
  const store = new MemStore();
  const dataDir = mkdtempSync(join(DATA_ROOT, 'iso-'));
  const atlas = await TestAtlas.start({ dataDir, env: {}, secrets: store, projects: remotes.options });
  const modelId = atlas.engine.agents.get('atlas').modelId;
  for (const id of ['munih', 'zurich']) atlas.engine.agents.create({ id, rolePrompt: `${id} role`, modelId });
  const cA = canaries('A');
  const cB = canaries('B');

  // CLAUDE.md: A's is in zurich's own workdir (the first project keeps it); B's is in its repo.
  mkdirSync(join(dataDir, 'workspaces', 'zurich'), { recursive: true });
  writeFileSync(join(dataDir, 'workspaces', 'zurich', 'CLAUDE.md'), `# A rules\n${cA.claude}\n`);
  remotes.repo('datinel/datinel', { 'README.md': 'datinel\n', 'CLAUDE.md': `# B rules\n${cB.claude}\n`, 'notes/b.md': `${cB.fact} lives in the repo too\n` });
  expect((await call(atlas, 'POST', '/projects', { name: 'Datinel', repo: 'datinel/datinel', lead: 'munih', members: ['zurich'] })).status).toBe(201);
  await expect
    .poll(async () => (await call<Project>(atlas, 'GET', '/projects/datinel')).body.members.map((m) => m.cloneState), { timeout: 20_000 })
    .toEqual(['ready', 'ready']);

  const seed = async (side: Side, id: string, c: Canaries): Promise<Side0> => {
    // Memories (project scope: shared rule = always-on, agent fact = searchable), a secret granted to every agent of that project.
    expect((await call(atlas, 'POST', '/memories', { kind: 'rule', scope: 'shared', text: c.rule, projectId: id })).status).toBe(201);
    expect((await call(atlas, 'POST', '/memories', { kind: 'fact', scope: 'agent:zurich', text: c.fact, projectId: id })).status).toBe(201);
    expect((await call(atlas, 'POST', '/secrets', { name: c.secretName, value: c.secretValue, description: `${side} only`, grant: 'all', project: id })).status).toBe(201);
    // A task (made by Master) whose run makes the artifact; a chat message.
    atlas.model.next(tu('artifact_create', { kind: 'markdown', title: c.artTitle, content: `# ${c.artTitle}\n${c.artBody}\n` }), say('Made it.'));
    const t = (await call<Card>(atlas, 'POST', '/cards', { title: c.taskTitle, body: c.taskBody, status: 'ready', assignee: 'zurich', projectId: id })).body;
    await settle(atlas, t.id);
    const chat = (await call<Card>(atlas, 'POST', `/agents/zurich/main-chat?project=${id}`)).body;
    atlas.model.next(say('noted'));
    await atlas.say(chat.id, c.chat);
    await atlas.idle(chat.id);
    const docs = (await call<{ id: string; title: string; projectId: string }[]>(atlas, 'GET', `/documents?project=${id}`)).body;
    const doc = docs.find((d) => d.title === c.artTitle);
    expect(doc, `artifact of ${side}`).toBeTruthy();
    expect(doc!.projectId).toBe(id);
    const m = (await call<Project>(atlas, 'GET', `/projects/${id}`)).body.members.find((x) => x.agentId === 'zurich')!;
    return { side, id, c, workspace: m.workspace ?? join(dataDir, 'workspaces', 'zurich'), docId: doc!.id, taskId: t.id };
  };
  const A = await seed('A', 'atlas', cA);
  const B = await seed('B', 'datinel', cB);
  expect(A.workspace).toBe(join(dataDir, 'workspaces', 'zurich'));
  expect(B.workspace).toMatch(/datinel/);
  expect(B.workspace).not.toBe(A.workspace);
  return {
    atlas,
    remotes,
    store,
    A,
    B,
    cleanup: async () => {
      await atlas.stop();
      remotes.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** A probe: the script the model plays, one tool call per turn, then a final text; the results come back by tool name. */
interface Probe {
  /** The probe's write_file landed in the other project's workspace. */
  plantedThere: boolean;
  /** Everything the provider was sent during the probe (system + messages + tools), one string per request. */
  requests: string[];
  results: Record<string, string[]>;
  cards: string[];
}

/** The tool calls an agent could use to look across projects. `other`: where the things are NOT supposed to be reachable. */
type Kind = 'general' | 'files' | 'shell' | 'all';
function script(other: Side0, kind: Kind): ContentBlock[][] {
  const general: [string, Record<string, unknown>][] = [
    ['shell', { command: 'echo CWD=$(pwd); env | sort; echo COUNT=$(env | grep -c "^CANARY_")' }],
    ['memory_search', { query: 'CANARY' }],
    ['artifact_list', {}],
    ['artifact_list', { query: 'CANARY' }],
    ['artifact_read', { artifact: other.docId }],
    ['task_list', {}],
    ['task_show', { id: other.taskId }],
    ['history_search', { query: 'CANARY' }],
    ['task_list', { project: other.id }], // zurich is not the lead of either project: crossing is refused
    ['artifact_list', { project: other.id }],
  ];
  const files: [string, Record<string, unknown>][] = [
    ['grep', { pattern: 'CANARY', path: '.' }],
    ['list_files', { path: '.' }],
    ['glob', { pattern: '**/*', path: '.' }],
    ['read_file', { path: join(other.workspace, 'CLAUDE.md') }],
    ['write_file', { path: join(other.workspace, 'planted.txt'), content: 'planted from the other project' }],
    ['edit_file', { path: join(other.workspace, 'README.md'), old_text: 'a', new_text: 'b' }],
  ];
  const shellSteps: [string, Record<string, unknown>][] = [
    ['shell', { command: `cat '${join(other.workspace, 'CLAUDE.md')}' 2>&1 | head -3; echo EXIT=$?` }],
    ['shell', { command: `echo planted > '${join(other.workspace, 'planted-by-shell.txt')}' 2>&1; ls '${other.workspace}' 2>&1 | head -20` }],
    ['shell', { command: 'cat ../CLAUDE.md ../../CLAUDE.md 2>&1 | head -3' }],
  ];
  const steps = kind === 'shell' ? shellSteps : kind === 'general' ? general : kind === 'files' ? files : [...general, ...files];
  return steps.map(([name, input]) => tu(name, input, `tu_${name}_${Math.random().toString(36).slice(2, 6)}`));
}

/** Run the script as a task in `where` (and the same as chat turns), return what the provider saw. */
async function probe(w: World, where: Side0, other: Side0, kind: Kind = 'all'): Promise<Probe> {
  const { atlas } = w;
  const before = atlas.model.calls.length;
  const steps = script(other, kind);
  const cards: string[] = [];
  // 1. A task in `where`.
  atlas.model.next(...steps, say('Probe done.'));
  const t = (await call<Card>(atlas, 'POST', '/cards', { title: `probe in ${where.side}`, body: 'look around', status: 'ready', assignee: 'zurich', projectId: where.id })).body;
  cards.push(t.id);
  await settle(atlas, t.id);
  // 2. A chat turn in `where` (the project's main chat for zurich), same script.
  // A fresh main chat for each probe: an earlier probe's tool results must not be in this one's transcript.
  const chat = (await call<Card>(atlas, 'POST', `/agents/zurich/main-chat/new?project=${where.id}`)).body;
  cards.push(chat.id);
  atlas.model.next(...steps, say('Probe done.'));
  await atlas.say(chat.id, 'look around from the chat');
  await atlas.idle(chat.id, 30_000);
  // Before the probe the planted file is nowhere (a positive control writes in its own project: remove it so a later probe starts clean).
  const planted = join(other.workspace, 'planted.txt');
  const plantedThere = existsSync(planted);
  if (where === other) rmSync(planted, { force: true });
  const calls = atlas.model.calls.slice(before).filter((c) => c.kind === 'main');
  expect(calls.length).toBeGreaterThanOrEqual(2 * (steps.length + 1));
  const results: Record<string, string[]> = {};
  // The last request of each run carries every tool result of that run.
  for (const c of calls.filter((x) => JSON.stringify(x.req.messages.at(-1)).includes('tool_result'))) {
    const names = new Map<string, string>();
    for (const m of c.req.messages) for (const b of m.content) if (b.type === 'tool_use') names.set(b.id, b.name);
    for (const m of c.req.messages) for (const b of m.content) if (b.type === 'tool_result') (results[names.get(b.tool_use_id) ?? '?'] ??= []).push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
  }
  return { plantedThere, requests: calls.map((c) => c.text + '\n' + JSON.stringify(c.req.tools)), results, cards };
}

/** Where a canary shows up: every request, every stored message of the probed cards, the shell results. */
async function sightings(w: World, p: Probe, c: Canaries): Promise<string[]> {
  const found: string[] = [];
  const stored = (await Promise.all(p.cards.map(async (id) => JSON.stringify((await call(w.atlas, 'GET', `/cards/${id}/messages`)).body)))).join('\n');
  for (const [kind, v] of Object.entries(c)) {
    if (p.requests.some((r) => r.includes(v))) found.push(`${kind}: sent to the provider`);
    if (stored.includes(v)) found.push(`${kind}: stored in a probed card`);
    for (const [tool, rs] of Object.entries(p.results)) if (rs.some((r) => r.includes(v))) found.push(`${kind}: result of ${tool}`);
  }
  return found;
}

test.describe.configure({ mode: 'serial' });
let w: World;
test.beforeAll(async () => {
  w = await world();
});
test.afterAll(async () => {
  await w?.cleanup();
});

test('seeding: every canary is where it should be, in its own project', async () => {
  const { atlas, A, B } = w;
  // The artifact files live in each project's own workspace.
  const docA = (await call<{ doc: { path: string; filesRoot: string } }>(atlas, 'GET', `/documents/${A.docId}`)).body.doc;
  const docB = (await call<{ doc: { path: string; filesRoot: string } }>(atlas, 'GET', `/documents/${B.docId}`)).body.doc;
  expect(readFileSync(join(A.workspace, docA.path), 'utf8')).toContain(A.c.artBody);
  expect(readFileSync(join(B.workspace, docB.path), 'utf8')).toContain(B.c.artBody);
  expect(existsSync(join(A.workspace, docB.path))).toBe(false);
  expect(existsSync(join(B.workspace, docA.path))).toBe(false);
  // Secrets are scoped to their project in the API too.
  const secrets = (id: string) => call<{ secrets: { name: string }[] }>(atlas, 'GET', `/secrets?project=${id}`).then((r) => r.body.secrets.map((s) => s.name));
  expect(await secrets('atlas')).toContain(A.c.secretName);
  expect(await secrets('atlas')).not.toContain(B.c.secretName);
  // Lists scoped to a project show only its own.
  const titles = async (path: string) => JSON.stringify((await call(atlas, 'GET', path)).body);
  for (const [mine, theirs] of [[A, B], [B, A]] as const) {
    const q = `?project=${mine.id}`;
    expect(await titles('/memories' + q)).toContain(mine.c.rule);
    expect(await titles('/memories' + q)).not.toContain(theirs.c.rule);
    expect(await titles('/memories' + q)).not.toContain(theirs.c.fact);
    expect(await titles('/documents' + q)).toContain(mine.c.artTitle);
    expect(await titles('/documents' + q)).not.toContain(theirs.c.artTitle);
    expect(await titles('/cards' + q)).toContain(mine.c.taskTitle);
    expect(await titles('/cards' + q)).not.toContain(theirs.c.taskTitle);
    expect(await titles('/chats' + q)).not.toContain(theirs.c.chat);
  }
});

for (const [from, to] of [['A', 'B'], ['B', 'A']] as const) {
  test(`positive control: in ${from} itself, the probe sees every ${from} canary (so « not found » elsewhere means « not reachable »)`, async () => {
    const own = from === 'A' ? w.A : w.B;
    const p = await probe(w, own, own);
    const seen = await sightings(w, p, own.c);
    // The prompt carries the instructions, the always-on memory and the secret's name; tools return the rest.
    for (const k of ['claude', 'rule', 'secretName'] as const) expect(seen, `${k} in the prompt`).toContain(`${k}: sent to the provider`);
    expect(p.results.shell!.join('\n')).toContain(own.c.secretName); // in the env of its shell (the value itself shows as [secret NAME])
    expect(p.results.shell!.join('\n')).toContain('COUNT=1');
    expect(p.results.shell!.join('\n')).not.toContain(own.c.secretValue); // redacted: the pill, never the value
    expect(seen).not.toContain('secretValue: sent to the provider');
    expect(p.results.memory_search!.join('\n')).toContain(own.c.fact);
    expect(p.results.artifact_list!.join('\n')).toContain(own.c.artTitle);
    expect(p.results.artifact_read!.join('\n')).toContain(own.c.artBody);
    expect(p.results.task_list!.join('\n')).toContain(own.c.taskTitle);
    expect(p.results.task_show!.join('\n')).toContain(own.c.taskBody);
    expect(p.results.history_search!.join('\n')).toContain('CANARY'); // a chat's history is its own: the seeded chat message is in the seeded chat, not in this fresh one
    expect(p.results.grep!.join('\n')).toContain('CANARY');
    expect(p.results.read_file!.join('\n')).toContain(own.c.claude);
    void to;
  });

  test(`${to} → ${from}: no ${to} canary reaches a task or a chat turn in ${from} (provider requests, tool results, stored messages, env, memory, artifacts, tasks, history)`, async () => {
    const [here, other] = from === 'A' ? [w.A, w.B] : [w.B, w.A];
    // `here` is where the agent works; `other` is the project whose canaries must stay out.
    const p = await probe(w, here, other, 'general');
    expect(await sightings(w, p, other.c), `canaries of ${other.side} seen in ${here.side}`).toEqual([]);
    // The env of the shell: none of the other project's secrets, name or value; its own only.
    const env = p.results.shell!.join('\n');
    expect(env).toContain(`CWD=${here.workspace}`);
    expect(env).toContain('COUNT=1');
    expect(env).toContain(here.c.secretName);
    expect(env).not.toContain(other.c.secretName);
    // Memory, artifacts, tasks: only the project's own; the other's id is refused, and the refusal says why.
    expect(p.results.memory_search!.join('\n')).toContain(here.c.fact);
    expect(p.results.artifact_list!.join('\n')).toContain(here.c.artTitle);
    expect(p.results.task_list!.join('\n')).toContain(here.c.taskTitle);
    expect(p.results.artifact_read!.join('\n')).toMatch(/not|no artifact|another project|member|lead/i);
    expect(p.results.task_show!.join('\n')).toMatch(/not|another project|member|lead/i);
    expect(p.results.task_list!.at(-1)).toMatch(/lead|member|not allowed|only/i);
    expect(p.results.artifact_list!.at(-1)).toMatch(/lead|member|not allowed|only/i);
  });

  // Known bug (#245): in project A an agent's workdir is its home folder, and B's clone is a sub-folder of it.
  test(`${to} → ${from}: file tools in ${from} can neither read nor write ${to}'s workspace`, async () => {
    const [here, other] = from === 'A' ? [w.A, w.B] : [w.B, w.A];
    // Expected to fail only while the clone is nested in the home workdir (#245 moves it out: then this runs as a plain test).
    test.fail(here.side === 'A' && other.workspace.startsWith(here.workspace + sep), "bug #245: B's clone is inside A's workdir, so A's file tools read and write it");
    const p = await probe(w, here, other, 'files');
    try {
      expect(await sightings(w, p, other.c), `canaries of ${other.side} seen in ${here.side}`).toEqual([]);
      expect(p.results.read_file!.join('\n')).toMatch(/outside/);
      expect(p.results.write_file!.join('\n')).toMatch(/outside/);
      expect(p.results.edit_file!.join('\n')).toMatch(/outside/);
      expect(p.plantedThere, JSON.stringify(p.results.write_file)).toBe(false);
      // Searching or listing the workdir shows nothing of the other project.
      expect(p.results.grep!.join('\n')).not.toContain(other.workspace);
      expect(p.results.list_files!.join('\n')).not.toMatch(/datinel\//);
      expect(p.results.glob!.join('\n')).not.toMatch(/datinel\//);
    } finally {
      rmSync(join(other.workspace, 'planted.txt'), { force: true }); // a bug's side effect: the test cleans up after itself
    }
  });

  // ACCEPTED LIMIT (Master, 19 Nov 2026, #248): the shell is not a sandbox; it runs with the project's folder as cwd, nothing more. A canary is reachable by an absolute path, both ways. Pinned as it is; if a sandbox ever comes, this test flips.
  test(`${to} → ${from}: the shell in ${from} (${from === 'A' ? 'home workdir' : 'clone'}) against ${to}'s workspace — current behaviour`, async () => {
    const [here, other] = from === 'A' ? [w.A, w.B] : [w.B, w.A];
    const p = await probe(w, here, other, 'shell');
    const out = (p.results.shell ?? []).join('\n');
    const read = out.includes(other.c.claude);
    const wrote = existsSync(join(other.workspace, 'planted-by-shell.txt'));
    rmSync(join(other.workspace, 'planted-by-shell.txt'), { force: true });
    console.log(`shell in ${here.side}: reads ${other.side}'s CLAUDE.md = ${read}, writes in ${other.side}'s workspace = ${wrote}`);
    // Pinned so a change (a sandbox, or a regression) is noticed.
    expect({ read, wrote }).toEqual({ read: true, wrote: true });
  });
}
