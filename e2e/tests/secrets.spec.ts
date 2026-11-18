import { expect } from '@playwright/test';
import { addSecret, openStep, runTask, say, settle, sh, test, toolResults, tu } from '../harness/secrets.ts';

/**
 * Secrets end to end (#210, features #206–#209): Settings → Secrets, an agent's shell, the chat, the server's lock,
 * and a leak audit after each scenario: the canary values must be in the secret store and nowhere else
 * (harness/leaks.ts). Desktop mode here = an in-memory keychain stand-in; server mode is in secrets-server.spec.ts.
 * Canary values are never typed in a scripted command (they would sit in the tool call): commands read $NAME.
 */

const V1 = 'canary-one-ABCDEF-123456';
const V2 = 'canary-two-UVWXYZ-98765432101';
const len = (v: string) => String(v.length + 1); // printenv | wc -c counts the newline

test('Master adds a secret and grants it to one agent: its command sees $NAME, another agent\'s does not; the chat hides the value behind a pill', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  leaks.watch('CANARY_ONE', V1);
  await page.goto(`${atlas.url}/#/settings/secrets`);
  await expect(page.getByText('No agent secret yet')).toBeVisible();
  await addSecret(page, { name: 'CANARY_ONE', value: V1, description: 'E2E canary', agents: ['atlas'] });
  const row = page.locator('[data-secret=CANARY_ONE]');
  await expect(row).toContainText('by Tester');
  await expect(row).toContainText('never used');
  await expect(row.locator('.sec-grant')).toHaveText(['atlas']);
  expect(store.get('CANARY_ONE')).toBe(V1); // the value is in the store…
  expect(JSON.stringify(atlas.db('SELECT * FROM secrets'))).not.toContain(V1); // …and SQLite has the row only

  // atlas: the variable is there, with the right value (its length), and the output hides it.
  const mine = await runTask(atlas, 'Use the key', 'atlas', sh('echo "key=$CANARY_ONE"; printenv CANARY_ONE | wc -c'));
  const [out] = toolResults(atlas);
  expect(out).toContain('key=[secret CANARY_ONE]');
  expect(out).not.toContain(V1);
  expect(out.trim().split('\n').at(-1)!.trim()).toBe(len(V1));
  await expect(row).toContainText(/used .* by\s*atlas/);

  // zurich: not granted. The variable is not in its environment, and naming it stops the command.
  await runTask(atlas, 'Peek at the key', 'zurich', sh('env | grep -c "^CANARY_ONE=" || true'), sh('echo "$CANARY_ONE"'));
  const results = toolResults(atlas);
  expect(results[0]).toMatch(/^exit 0\n0\s*$/);
  expect(results[0]).not.toContain(V1);
  expect(results[1]).toMatch(/secret CANARY_ONE is not granted to zurich/);

  // The chat: the step's terminal shows the pill, and says what Atlas did.
  const term = await openStep(page, atlas, mine, 'echo "key=$CANARY_ONE"');
  await expect(term.locator('.sec-redacted')).toHaveText('[secret CANARY_ONE]');
  await expect(page.getByText('Atlas replaced it before the model, the chat and the logs saw it')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(V1);
});

test('replace value is live: the next command gets the new value, the store holds only it', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  leaks.watch('CANARY_ONE', V1);
  leaks.watch('CANARY_ONE (replaced)', V2);
  await page.goto(`${atlas.url}/#/settings/secrets`);
  await addSecret(page, { name: 'CANARY_ONE', value: V1, agents: ['atlas'] });
  await runTask(atlas, 'Before', 'atlas', sh('printenv CANARY_ONE | wc -c'));
  expect(toolResults(atlas)[0].trim().split('\n').at(-1)!.trim()).toBe(len(V1));

  const row = page.locator('[data-secret=CANARY_ONE]');
  await row.getByRole('button', { name: 'Replace value' }).click();
  await page.getByLabel('New value of CANARY_ONE').fill(V2);
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(page.getByLabel('New value of CANARY_ONE')).toHaveCount(0);
  await expect.poll(() => store.get('CANARY_ONE')).toBe(V2);
  expect([...store.map.values()]).not.toContain(V1);

  await runTask(atlas, 'After', 'atlas', sh('echo "key=$CANARY_ONE"; printenv CANARY_ONE | wc -c'));
  const out = toolResults(atlas)[0];
  expect(out).toContain('key=[secret CANARY_ONE]');
  expect(out.trim().split('\n').at(-1)!.trim()).toBe(len(V2));
});

test('delete: the row and the stored value go; the variable is gone from the next command', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  leaks.watch('CANARY_ONE', V1);
  await page.goto(`${atlas.url}/#/settings/secrets`);
  await addSecret(page, { name: 'CANARY_ONE', value: V1, all: true });
  await expect(page.locator('[data-secret=CANARY_ONE] .sec-grant')).toHaveText('All agents');
  const row = page.locator('[data-secret=CANARY_ONE]');
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row).toContainText('Delete CANARY_ONE for good?');
  await row.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(row).toHaveCount(0);
  expect(store.names()).toEqual([]);
  expect(atlas.db('SELECT name FROM secrets')).toEqual([]);

  await runTask(atlas, 'After delete', 'atlas', sh('echo "[$CANARY_ONE]"'));
  expect(toolResults(atlas)[0]).toBe('exit 0\n[]\n');
});

test('an agent\'s secret_set (command form) adds a row "by @agent" with its task; the value never reaches the agent, only its shell', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  const V = 'agent-canary-1234567';
  leaks.watch('AGENT_MADE', V);
  // The value is computed by the command, so it is not written anywhere in the model's call.
  const set = tu('secret_set', { name: 'AGENT_MADE', description: 'Made by the agent in the E2E', command: "printf 'agent-canary-%s' \"$(echo 7654321 | rev)\"" });
  const task = await runTask(atlas, 'Make a key', 'atlas', set, sh('echo "got=$AGENT_MADE"'));
  expect(store.get('AGENT_MADE')).toBe(V);
  expect(toolResults(atlas)[0]).toContain('stored AGENT_MADE, 20 chars, granted to you only');
  expect(toolResults(atlas)[1]).toContain('got=[secret AGENT_MADE]');

  await page.goto(`${atlas.url}/#/settings/secrets`);
  const row = page.locator('[data-secret=AGENT_MADE]');
  await expect(row).toContainText('by atlas');
  await expect(row).toContainText(`#${task.number}`);
  await expect(row).toContainText('Made by the agent in the E2E');
  await expect(row.locator('.sec-grant')).toHaveText(['atlas']); // granted to the agent that made it, nobody else
  expect(atlas.db("SELECT created_by, grant_to FROM secrets WHERE name = 'AGENT_MADE'")).toEqual([{ created_by: 'atlas', grant_to: 'agents' }]);

  // Another agent can't use it.
  await runTask(atlas, 'Borrow it', 'zurich', sh('echo "$AGENT_MADE"'));
  expect(toolResults(atlas)[0]).toMatch(/not granted to zurich/);
});

test('a task blocks on a missing secret; Master adds the value and the task resumes by itself', async ({ page, w }) => {
  const { atlas, store, leaks } = w;
  const V = 'etherscan-canary-0042-xyz';
  leaks.watch('ETHERSCAN_KEY', V);
  const need = tu('task_block', { kind: 'capability', question: 'I need the Etherscan key to read the chain.', secret: 'ETHERSCAN_KEY', secret_description: 'Etherscan API key' });
  atlas.model.next(need);
  const task = await atlas.task('Read the chain', 'atlas');
  await settle(atlas, task.id);
  expect((await atlas.card(task.id)).status).toBe('blocked');

  await page.goto(`${atlas.url}/#/settings/secrets`);
  const row = page.locator('[data-secret=ETHERSCAN_KEY]');
  await expect(row).toContainText('No value');
  await expect(row).toContainText('Asked by');
  await expect(row).toContainText(`#${task.number} is blocked until you add it`);
  expect(store.names()).toEqual([]);

  // Master gives the value: the task goes back to work and uses it.
  atlas.model.next(sh('echo "token=$ETHERSCAN_KEY"'), say('Read it.'));
  const before = atlas.model.of('main').length;
  await row.getByRole('button', { name: 'Add the value' }).click();
  await page.getByLabel('Value of ETHERSCAN_KEY').fill(V);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => atlas.model.of('main').length, { timeout: 20_000 }).toBeGreaterThan(before + 1);
  await expect.poll(async () => (await atlas.card(task.id)).status).toBe('blocked'); // it answered with its final question
  await atlas.idle(task.id);
  expect(store.get('ETHERSCAN_KEY')).toBe(V);
  const seen = atlas.model.of('main').slice(before).map((c) => c.text).join('\n');
  expect(seen).toContain('The secret ETHERSCAN_KEY now has a value');
  expect(toolResults(atlas).at(-1)).toContain('token=[secret ETHERSCAN_KEY]');
  await expect(row).not.toContainText('No value');
  await expect(row).toContainText('by atlas');
});
