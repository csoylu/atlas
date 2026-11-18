import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test as plain, expect } from '@playwright/test';
import { TestAtlas } from '../harness/engine.ts';
import { Leaks, files } from '../harness/leaks.ts';
import { MemStore, runTask, say, sh, test, toolResults, tu } from '../harness/secrets.ts';
import type { ContentBlock } from '@atlas/shared';
import type { ModelRequest } from '../../packages/engine/src/providers/types.ts';

/**
 * Leak audit (#210). Part 1: the audit itself catches a leak (positive controls). Part 2: one agent that prints a
 * secret by every road the shell has (stdout, stderr, a failing command, a background process, a huge output saved to a
 * file, read back with read_file), then a rotation and /compact: the canary is nowhere outside the store.
 * Part 3: what the redactor does NOT catch today, as tests that pin the behaviour (docs/qa/210-secrets-leak-audit.md « Known limits »).
 * A test that goes red there means a limit was fixed: update the doc and the test together.
 */

const K = 'leak-canary-QWERTY-0987654321';

plain('the audit finds a value in a file, the logs, an API response and a model request (positive control)', async () => {
  const atlas = await TestAtlas.start({ secrets: new MemStore(), env: {} });
  const leaks = new Leaks();
  try {
    leaks.attach(atlas);
    leaks.watch('PLANTED', K);
    expect(await leaks.findings(atlas)).toEqual([]);
    writeFileSync(join(atlas.dataDir, 'planted.txt'), 'x' + Buffer.from(K).toString('base64') + 'x');
    console.log('engine log line with ' + K);
    // Master pastes the value in a chat: it lands in SQLite, the API, and the model's request.
    const chat = await atlas.chat();
    await atlas.say(chat.id, 'my key is ' + K);
    await atlas.idle(chat.id);
    const found = await leaks.findings(atlas);
    const where = (re: RegExp) => found.some((f) => re.test(f));
    expect(where(/^file planted\.txt: PLANTED \(base64\)/)).toBe(true);
    expect(where(/^stdout: PLANTED \(plain\)/)).toBe(true);
    expect(where(/^api responses \(sweep\): PLANTED \(plain\)/)).toBe(true);
    expect(where(/^model requests: PLANTED \(plain\)/)).toBe(true);
    expect(where(/^file atlas\.db(-wal)?: PLANTED \(plain\)/)).toBe(true);
    expect(where(/^bus events: PLANTED \(plain\)/)).toBe(true);
  } finally {
    leaks.detach();
    await atlas.stop();
  }
});

test('every road a shell has to print a secret: nothing outside the store, chat and model see the pill', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  leaks.watch('LEAK_KEY', K);
  leaks.allow(/^outputs\/[^/]+\/bg_.*\.log$/); // known limit: a background process's log keeps the raw value (docs/qa/210-secrets-leak-audit.md)
  leaks.watch('LEAK_KEY (rotated)', 'rotated-QWERTY-5555555555');
  await page.goto(`${atlas.url}/#/settings/secrets`);
  atlas.engine.secrets.create({ name: 'LEAK_KEY', value: K, description: 'audit', grant: 'all', agents: [], project: null }, { by: 'user' });

  const bgId = (req: ModelRequest): string => /started (\S+) in the background/.exec(JSON.stringify(req.messages))![1]!;
  const savedPath = (req: ModelRequest): string => /full output is in (\S+\.txt)/.exec(JSON.stringify(req.messages))![1]!;
  const task = await runTask(
    atlas,
    'Print the key every way',
    'atlas',
    sh('echo "out=$LEAK_KEY"; echo "err=$LEAK_KEY" >&2; echo "bye=$LEAK_KEY"; exit 3'),
    sh('echo "bg=$LEAK_KEY"; sleep 1; echo "bg2=$LEAK_KEY"; touch bg-done', true),
    sh('for i in $(seq 300); do [ -f bg-done ] && break; sleep 0.1; done; [ -f bg-done ]'), // wait for the marker the background process leaves after both lines
    (req) => tu('shell_output', { id: bgId(req) }),
    sh('head -c 29900 /dev/zero | tr "\\0" x; echo; echo "tail=$LEAK_KEY"; head -c 2000 /dev/zero | tr "\\0" y; echo'),
    (req) => tu('read_file', { path: savedPath(req) }),
    sh('printenv LEAK_KEY | wc -c'),
  );
  const out = toolResults(atlas);
  expect(out[0]).toMatch(/^exit 3\n.*out=\[secret LEAK_KEY\]/s);
  expect(out[0]).toContain('err=[secret LEAK_KEY]');
  expect(out.join('\n')).not.toContain(K);
  expect(out.some((o) => o.includes('bg=[secret LEAK_KEY]'))).toBe(true); // shell_output: hidden too
  expect(out.some((o) => /output is \d+ chars/.test(o))).toBe(true); // the big one was cut, and saved…
  expect(out.filter((o) => o.includes('tail=[secret LEAK_KEY]')).length).toBeGreaterThanOrEqual(2); // …saved file read back: hidden there too

  // Rotation: the new value is hidden from then on, and is the only one left in the store.
  const R = 'rotated-QWERTY-5555555555';
  const put = await fetch(`${atlas.url}/api/secrets/LEAK_KEY`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: R }) });
  expect(put.status).toBe(204);
  expect([...store.map.values()]).toEqual([R]);
  await runTask(atlas, 'Print the new key', 'atlas', sh('echo "again=$LEAK_KEY"'));
  expect(toolResults(atlas)[0]).toContain('again=[secret LEAK_KEY]');

  // /compact sends the transcript to the summarizer; the chat opened in the browser reads every step.
  expect((await atlas.command(task.id, 'compact')).status).toBe(200);
  await atlas.idle(task.id);
  expect(atlas.model.of('summary').length).toBeGreaterThan(0);
  await page.goto(`${atlas.url}/#/board?card=${task.id}`);
  await page.getByText('3 steps').first().click(); // the steps are grouped: open the first group, then its first command
  await page.locator('.step', { hasText: 'out=$LEAK_KEY' }).first().click();
  await expect(page.locator('.sec-redacted').first()).toBeVisible();
  await expect(page.locator('body')).not.toContainText(K);
});

// ── Part 3: known limits of the redactor ────────────────────────────────────────────────────────────────────────────
// The redactor replaces the exact stored value (8 characters or more) in the output of every tool. It cannot see a
// value that was changed before it was printed, nor one that is written somewhere else than a tool output.

const LIMIT = 'limit-canary-MNBVCX-246810';
/** One task for `atlas` that runs `commands`; returns what the model got back, in order. */
async function print(w: { atlas: TestAtlas; leaks: Leaks }, ...commands: string[]): Promise<string[]> {
  await runTask(w.atlas, 'Print the key in odd ways', 'atlas', ...commands.map((c) => sh(c)));
  return toolResults(w.atlas);
}

test.describe('known limits (docs/qa/210-secrets-leak-audit.md)', () => {
  test.beforeEach(async ({ w }) => {
    w.atlas.engine.secrets.create({ name: 'LIMIT_KEY', value: LIMIT, description: 'limits', grant: 'all', agents: [], project: null }, { by: 'user' });
  });

  test('a transformed value is not recognised: base64, hex, reversed, split in pieces, a single character', async ({ w }) => {
    const [b64, hex, rev, split, one] = await print(
      w,
      'printf %s "$LIMIT_KEY" | base64',
      'printf %s "$LIMIT_KEY" | od -An -tx1 | tr -d " \\n"',
      'printf %s "$LIMIT_KEY" | rev',
      'echo "${LIMIT_KEY:0:10}"; echo "${LIMIT_KEY:10}"',
      'echo "${LIMIT_KEY:0:1}"',
    );
    expect(b64).toContain(Buffer.from(LIMIT).toString('base64'));
    expect(hex).toContain(Buffer.from(LIMIT).toString('hex'));
    expect(rev).toContain([...LIMIT].reverse().join(''));
    expect(split).toContain(LIMIT.slice(0, 10));
    expect(split).toContain(LIMIT.slice(10));
    expect(split).not.toContain('[secret');
    expect(one!.trim().endsWith('l')).toBe(true);
    // Nothing here is a bug of the redactor: it cannot know what a program did to the value. The agent is told not to.
  });

  test('a value under 8 characters is not hidden at all (the UI says so when it is added)', async ({ w }) => {
    w.atlas.engine.secrets.create({ name: 'SHORT_KEY', value: 'abc123', description: '', grant: 'all', agents: [], project: null }, { by: 'user' });
    const [out] = await print(w, 'echo "short=$SHORT_KEY"');
    expect(out).toContain('short=abc123');
  });

  test('after a rotation the old value is no longer hidden (it is gone from the store: nothing remembers it)', async ({ w }) => {
    const OLD = 'old-canary-ZZZZZZ-111111';
    w.atlas.engine.secrets.create({ name: 'OLD_KEY', value: OLD, description: '', grant: 'all', agents: [], project: null }, { by: 'user' });
    w.atlas.engine.secrets.setValue('OLD_KEY', 'new-canary-YYYYYY-222222', { by: 'user' });
    const [out] = await print(w, `echo "${OLD}"`); // e.g. a log line, an old config file still holding it
    expect(out).toContain(OLD);
  });

  test('a file the agent writes keeps the value on disk and in the rewind snapshot; the files API and the Library (SQLite) show [secret NAME] (#226)', async ({ w }) => {
    const [out] = await print(w, 'mkdir -p docs; echo "$LIMIT_KEY" > saved.txt; echo "k: $LIMIT_KEY" > docs/note.md; cat saved.txt');
    expect(out).toContain('[secret LIMIT_KEY]'); // the output is hidden…
    const hits = files(w.atlas.dataDir).filter((f) => f.data.includes(Buffer.from(LIMIT)));
    expect(hits.map((f) => f.rel).some((p) => p.endsWith('saved.txt'))).toBe(true); // …the file the agent made is not
    // The files API serves the workspace with known values hidden (#226)…
    const served = await (await fetch(`${w.atlas.url}/api/files/atlas/saved.txt`)).text();
    expect(served).toContain('[secret LIMIT_KEY]');
    expect(served).not.toContain(LIMIT);
    // …and docs/note.md becomes a Library artifact the next time a file tool writes: its versions are stored redacted.
    await runTask(w.atlas, 'Write a page', 'atlas', tu('write_file', { path: 'docs/other.md', content: 'hello' }));
    const inDb = JSON.stringify(w.atlas.db('SELECT * FROM document_versions'));
    expect(inDb).toContain('k: [secret LIMIT_KEY]');
    expect(inDb).not.toContain(LIMIT);
    // The snapshot taken for rewinds (a git store on disk: compressed, so read its objects) keeps the file as it is.
    w.leaks.snapshots(w.atlas);
    expect(w.leaks.sink('checkpoint snapshots')).toContain(LIMIT);
  });

  test('a user who pastes a value into a chat: it is stored as typed and sent to the model (the redactor only reads tool outputs)', async ({ w }) => {
    w.atlas.engine.secrets.create({ name: 'PASTED_KEY', value: 'pasted-canary-AAAA-333333', description: '', grant: 'all', agents: [], project: null }, { by: 'user' });
    const chat = await w.atlas.chat();
    await w.atlas.say(chat.id, 'here is the key: pasted-canary-AAAA-333333');
    await w.atlas.idle(chat.id);
    expect(JSON.stringify(w.atlas.db('SELECT content FROM messages'))).toContain('pasted-canary-AAAA-333333');
    expect(w.atlas.model.lastMain.text).toContain('pasted-canary-AAAA-333333');
  });

  test('secret_set with a value: the model provider already saw it, the stored transcript has [secret NAME]', async ({ w }) => {
    const V = 'typed-canary-BBBB-444444';
    await runTask(w.atlas, 'Store a typed key', 'atlas', tu('secret_set', { name: 'TYPED_KEY', value: V }), sh('echo "t=$TYPED_KEY"'));
    expect(w.atlas.model.of('main').length).toBe(3);
    // The first request after the call: the model's own call comes back in its history, with the real value or not.
    const history = JSON.stringify(w.atlas.model.of('main')[1]!.req.messages);
    expect(history).toContain('[secret TYPED_KEY]'); // what is stored is what the next request carries
    expect(JSON.stringify(w.atlas.db('SELECT content FROM messages'))).not.toContain(V);
    expect(JSON.stringify(w.atlas.db('SELECT * FROM tool_calls'))).not.toContain(V);
  });

  test('a value that straddles the 30000-character cut of a long output is hidden whole (fixed by #227)', async ({ w }) => {
    // The shell tool hides values in the whole output first, then keeps the last 30000 characters: no half value survives.
    const tail = 30000 - LIMIT.length + 7; // the raw value starts 7 characters before the kept part
    const [out] = await print(w, `head -c 100 /dev/zero | tr "\\0" x; printf %s "$LIMIT_KEY"; head -c ${tail} /dev/zero | tr "\\0" z`);
    expect(out).toMatch(/output is \d+ chars: showing the last 30000/);
    expect(out).not.toContain(LIMIT.slice(7));
    expect(out).not.toContain(LIMIT.slice(0, 7));
    expect(out).toMatch(/^x\[secret LIMIT_KEY\]z/m); // hidden first (the marker is 8 characters shorter), then cut: one x before it
  });

  test('a background process writes its log to disk with the value in it', async ({ w }) => {
    await runTask(w.atlas, 'Background print', 'atlas', sh('echo "bg=$LIMIT_KEY"; sleep 1', true), say('started'));
    await expect.poll(() => files(w.atlas.dataDir).some((f) => /outputs.*\.log$/.test(f.rel) && f.data.includes(Buffer.from(LIMIT))), { timeout: 10_000 }).toBe(true);
  });
});
