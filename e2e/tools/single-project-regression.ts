/**
 * #218 item 3 — a single-project Atlas must not notice that projects exist.
 *
 * Takes a COPY of a real database (never the file itself), starts this build's engine on it (the build migrates it),
 * and checks, against what the file held before:
 *   - every table's row count that the migrations must not touch is unchanged, and the integrity check is « ok »;
 *   - every chat and task keeps its messages (count and last seq, per card), over the API too, not only in SQLite;
 *   - every agent's main chat is the same chat as before (0051 moved `agents.main_chat` to `project_members.main_chat`);
 *   - the default project is the oldest one, every task, chat, artifact and workflow without a project lives in it;
 *   - a workflow and a schedule that are due fire: a second engine with a dispatcher and a scripted model, the due time
 *     set in the past on the copy, starts a run, creates its task, and moves `next_run_at` on.
 *
 * SAFETY: a `.backup` of a live database carries the real pids of the shell tool calls and background processes that
 * were running at that moment. An engine started on it treats them as orphans once their (copied) lease has expired
 * and SIGKILLs their process groups: they would be the live app's shells. So the copy is neutralised before the first
 * start (`pid = NULL` on every running tool call and background process; both kill paths return on a null pid), and a
 * check proves it: a live process planted in the copy survives the whole run.
 *
 * Run (macOS, from the repo root, after `npm ci` and `npm run build`):
 *   sqlite3 "<data>/atlas.db" ".backup $TMPDIR/reg/live.db"
 *   npx tsx e2e/tools/single-project-regression.ts $TMPDIR/reg/live.db
 * Exit 1 on any problem; prints one line per check.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { startEngine } from '../../packages/engine/src/index.ts';
import { Scripted } from '../harness/scripted.ts';

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error('usage: single-project-regression.ts <copy of atlas.db>');
  process.exit(2);
}
const problems: string[] = [];
const ok = (what: string, good: boolean, detail = '') => {
  console.log(`${good ? 'ok  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
  if (!good) problems.push(what);
};

const dir = mkdtempSync(join(tmpdir(), 'atlas-regression-'));
const dbFile = join(dir, 'atlas.db');
copyFileSync(src, dbFile);
for (const ext of ['-wal', '-shm']) if (existsSync(src + ext)) copyFileSync(src + ext, dbFile + ext);
mkdirSync(join(dir, 'workspaces', 'atlas'), { recursive: true });

// Never let this engine signal a process of the real app: forget every pid the copy holds for a running row, then
// plant a live process of our own (its own process group) on a tool call and on a background process to prove it.
const sleeper = spawn('sleep', ['900'], { detached: true, stdio: 'ignore' });
sleeper.unref();
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
process.on('exit', () => {
  try {
    process.kill(-sleeper.pid!, 'SIGKILL');
  } catch {
    // already gone
  }
});
let planted = '';
{
  const w = new Database(dbFile);
  const call = w.prepare("SELECT t.id FROM tool_calls t JOIN runs r ON r.id = t.run_id WHERE r.status != 'running' LIMIT 1").get() as { id: number } | undefined;
  if (call) {
    w.prepare("UPDATE tool_calls SET status = 'running', pid = ? WHERE id = ?").run(sleeper.pid, call.id);
    planted = `tool call ${call.id}`;
  }
  const card = w.prepare('SELECT id FROM cards LIMIT 1').get() as { id: string } | undefined;
  if (card) {
    w.prepare("INSERT INTO background_processes (id, agent_id, card_id, command, pid, log_path, status, owner, lease_until, started_at) VALUES ('bg_regression', 'x', ?, 'sleep', ?, '/dev/null', 'running', 'regression', ?, ?)").run(card.id, sleeper.pid, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 120_000).toISOString());
    planted += `${planted ? ' and ' : ''}background process`;
  }
  // The neutralising itself, after the plants: they are running rows with a pid like the live app's.
  const cut = w.prepare("UPDATE tool_calls SET pid = NULL WHERE status = 'running'").run().changes;
  const bg = w.prepare("UPDATE background_processes SET pid = NULL WHERE status = 'running'").run().changes;
  w.close();
  console.log(`neutralised ${cut} running tool call(s) and ${bg} background process(es) of the copy (planted ones included); planted a live process on ${planted || 'nothing'}`);
}

const raw = <T>(sql: string, ...a: unknown[]): T[] => {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(sql).all(...a) as T[];
  } finally {
    db.close();
  }
};
const has = (table: string, col?: string): boolean => {
  const t = raw<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
  return col ? t.some((c) => c.name === col) : t.length > 0;
};

// ── Before: what the file holds ───────────────────────────────────────────────────────────────────────────────
const TABLES = ['cards', 'messages', 'conversations', 'runs', 'tool_calls', 'memories', 'documents', 'document_versions', 'folders', 'workflows', 'workflow_nodes', 'workflow_edges', 'workflow_runs', 'card_prs', 'agents', 'models', 'settings', 'secrets', 'notifications', 'checkpoints', 'context_clears']
  .filter((t) => has(t));
const countOf = (t: string) => raw<{ n: number }>(`SELECT COUNT(*) n FROM ${t}`)[0]!.n;
const before = Object.fromEntries(TABLES.map((t) => [t, countOf(t)]));
// Canvases the live app made after the last conversion: this build converts each one to an html page at start (#120), one
// document with one version each; they are the only documents a start may add.
const pending = has('canvases') && has('documents', 'from_canvas') ? raw<{ n: number }>('SELECT COUNT(*) n FROM canvases c WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.from_canvas = c.id)')[0]!.n : 0;
const migBefore = raw<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')[0]!.name;
// The messages the API shows: every row that no rewind hid (a rewound message stays in the file, out of the chat).
const seqs = new Map<string, number[]>();
for (const r of raw<{ card_id: string; seq: number }>('SELECT c.id AS card_id, m.seq FROM cards c JOIN messages m ON m.conversation_id = c.conversation_id WHERE m.rewind_id IS NULL ORDER BY c.id, m.seq')) {
  const l = seqs.get(r.card_id) ?? [];
  l.push(r.seq);
  seqs.set(r.card_id, l);
}
const mainBefore = new Map<string, string | null>(
  has('agents', 'main_chat')
    ? raw<{ id: string; main_chat: string | null }>('SELECT id, main_chat FROM agents').map((r) => [r.id, r.main_chat])
    : raw<{ agent_id: string; main_chat: string | null }>('SELECT agent_id, main_chat FROM project_members WHERE home = 1').map((r) => [r.agent_id, r.main_chat]),
);
console.log(`database: ${src}, last migration ${migBefore}, ${before.cards} cards, ${before.messages} messages, ${before.workflows} workflows`);

// ── After the migration, over the API ─────────────────────────────────────────────────────────────────────────
const model = new Scripted();
const start = (dispatch: boolean) => startEngine({ dbFile, dataDir: dir, port: 0, dispatch, env: {}, manageLocal: false, memoryReview: false, providers: () => model, uiDir: join(import.meta.dirname, '..', '..', 'packages', 'ui', 'dist') });
const get = async <T>(base: string, path: string): Promise<T> => {
  const r = await fetch(base + '/api' + path);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
};

let e = await start(false);
try {
  const base = e.url;
  const migAfter = raw<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')[0]!.name;
  console.log(`migrated: ${migBefore} → ${migAfter}`);
  ok('integrity_check is ok', raw<{ integrity_check: string }>('PRAGMA integrity_check')[0]!.integrity_check === 'ok');
  ok('foreign_key_check is empty', raw('PRAGMA foreign_key_check').length === 0);
  for (const t of TABLES) {
    if (['settings', 'workflows'].includes(t)) continue; // a build may add a built-in row (checked below)
    // Starting an engine closes what a stop left open (a run cut by the last stop gets its note): rows may be added, never lost.
    if (t === 'documents' || t === 'document_versions') {
      ok(`${t}: ${before[t]} rows before, ${pending} canvas(es) converted, nothing else changed`, countOf(t) === before[t]! + pending, `now ${countOf(t)}`);
      continue;
    }
    if (['messages', 'runs', 'tool_calls', 'notifications', 'checkpoints'].includes(t)) {
      ok(`${t}: ${before[t]} rows before, none lost`, countOf(t) >= before[t]!, `now ${countOf(t)}`);
      continue;
    }
    ok(`${t}: ${before[t]} rows before and after`, countOf(t) === before[t], `now ${countOf(t)}`);
  }
  ok('workflows: none lost', countOf('workflows') >= before.workflows!, `${before.workflows} → ${countOf('workflows')}`);

  // Projects: one, the default; everything without a project is in it.
  const projects = await get<{ id: string; status: string; createdAt: string; members: { agentId: string; mainChat: string | null; home: boolean; cloneState: string }[] }[]>(base, '/projects');
  const active = projects.filter((p) => p.status === 'active').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const dflt = active[0]!;
  console.log(`projects: ${projects.map((p) => `${p.id}(${p.members.length} members)`).join(', ')}`);
  ok('a default project exists (the oldest active one)', !!dflt);
  const orphan = (t: string) => (has(t, 'project_id') ? raw<{ n: number }>(`SELECT COUNT(*) n FROM ${t} WHERE project_id IS NULL`)[0]!.n : 0);
  for (const t of ['cards', 'documents', 'folders']) ok(`${t}: every row has a project`, orphan(t) === 0, `${orphan(t)} without`);
  if (projects.length === 1) {
    const other = raw<{ n: number }>('SELECT COUNT(*) n FROM cards WHERE project_id != ?', dflt.id)[0]!.n;
    ok('single project: every task and chat is in it', other === 0, `${other} elsewhere`);
    ok('single project: every member is home and ready (own workdir, no clone)', dflt.members.every((m) => m.home && m.cloneState === 'ready'));
  }

  // Every card keeps its history, over the API (a card is reachable by id whatever its status: archived ones too).
  let bad = 0;
  let missing = 0;
  let checked = 0;
  for (const [id, want] of seqs) {
    const r = await fetch(`${base}/api/cards/${id}`);
    if (!r.ok) {
      missing++;
      if (missing <= 5) console.log(`  card ${id}: GET answers ${r.status}`);
      continue;
    }
    const msgs = await get<{ seq: number }[]>(base, `/cards/${id}/messages`);
    const have = new Set(msgs.map((m) => m.seq));
    checked++;
    const gone = want.filter((s) => !have.has(s));
    if (gone.length) {
      bad++;
      if (bad <= 5) console.log(`  card ${id}: ${gone.length} of ${want.length} messages missing after (seq ${gone.slice(0, 5).join(', ')})`);
    }
  }
  ok(`every card with messages answers (${seqs.size} cards)`, missing === 0, `${missing} do not`);
  ok(`every message a chat showed is still shown, over the API (${checked} cards)`, bad === 0, `${bad} cards lost some`);

  // Main chats: the same chat as before, for every agent.
  let moved = 0;
  for (const [agent, chat] of mainBefore) {
    const m = dflt.members.find((x) => x.agentId === agent);
    if (!chat) continue;
    if (m?.mainChat !== chat) {
      moved++;
      console.log(`  ${agent}: main chat ${chat} before, ${m?.mainChat} after`);
    }
  }
  ok('every agent keeps the same main chat', moved === 0, `${moved} changed`);
  const sample = [...mainBefore.entries()].find(([, c]) => c);
  if (sample) {
    const r = await fetch(`${base}/api/agents/${sample[0]}/main-chat`, { method: 'POST' });
    ok('POST /agents/:id/main-chat (no project) answers the same chat', ((await r.json()) as { id: string }).id === sample[1]);
  }
} finally {
  await e.stop();
}

// ── Schedules and workflows still fire ────────────────────────────────────────────────────────────────────────
{
  const due = raw<{ id: string; name: string; next_run_at: string | null; enabled: number }>('SELECT id, name, next_run_at, enabled FROM workflows WHERE enabled = 1 AND next_run_at IS NOT NULL');
  const sch = has('schedules') ? raw<{ n: number }>('SELECT COUNT(*) n FROM schedules')[0]!.n : 0;
  console.log(`enabled workflows with a trigger clock: ${due.map((d) => d.id).join(', ') || 'none'}; legacy schedules table rows: ${sch}`);
  ok('there is a workflow to fire on this database', due.length > 0);
  if (due.length) {
    const w = new Database(dbFile);
    const past = new Date(Date.now() - 60_000).toISOString();
    w.prepare('UPDATE workflows SET next_run_at = ? WHERE id = ?').run(past, due[0]!.id);
    w.close();
    const runsBefore = countOf('workflow_runs');
    const cardsBefore = countOf('cards');
    e = await start(true);
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && countOf('workflow_runs') === runsBefore) await new Promise((r) => setTimeout(r, 100));
      ok(`the due workflow ${due[0]!.id} started a run`, countOf('workflow_runs') > runsBefore);
      const after = raw<{ next_run_at: string | null; last_error: string | null }>('SELECT next_run_at, last_error FROM workflows WHERE id = ?', due[0]!.id)[0]!;
      ok('its next run moved into the future', !!after.next_run_at && after.next_run_at > new Date().toISOString(), String(after.next_run_at));
      ok('it recorded no error', !after.last_error, String(after.last_error));
      const t2 = Date.now() + 20_000;
      while (Date.now() < t2 && countOf('cards') === cardsBefore) await new Promise((r) => setTimeout(r, 100));
      ok('its agent step made its task', countOf('cards') > cardsBefore, `${cardsBefore} → ${countOf('cards')} cards`);
      // The scripted model answered it: the run reached a state, not a crash.
      const run = raw<{ status: string; error: string | null }>('SELECT state AS status, reason AS error FROM workflow_runs ORDER BY started_at DESC LIMIT 1')[0];
      console.log(`  last workflow run: ${run?.status}${run?.error ? ` (${run.error})` : ''}; the model was asked ${model.calls.length} time(s)`);
    } finally {
      await e.stop();
    }
  }
}

ok('the live process planted in the copy survived both engines (no pid of a copy is ever signalled)', alive(sleeper.pid!), planted || 'nothing planted');
rmSync(dir, { recursive: true, force: true });
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall checks pass');
