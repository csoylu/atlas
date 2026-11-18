import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { TestAtlas } from '../harness/engine.ts';
import { Leaks } from '../harness/leaks.ts';
import { addSecret, runTask, sh, toolResults } from '../harness/secrets.ts';
import { serverSecretStore } from '../../packages/engine/src/secretFile.ts';

/**
 * Server mode (#208): secrets live in secrets.enc, locked until the secrets password is typed. First password → add a
 * secret → restart (locked) → a command that needs it stops → wrong password → unlock → it works → Lock now. The value
 * and the password are watched by the leak audit the whole time (secrets.enc must not hold either in the clear).
 */

const PW = 'server-secrets-password-ZZ91';
const V = 'server-canary-KLMNOP-5550123';
const kdf = { N: 2 ** 10, failDelayMs: 0 }; // scrypt cost and wrong-password delay: lowered for the test

test('locked → unlock → works → Lock now, on a server', async ({ page }) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-srv-'));
  const open = async () => {
    const env: NodeJS.ProcessEnv = {};
    return TestAtlas.start({ dataDir, env, secrets: await serverSecretStore(dataDir, env, kdf) });
  };
  let atlas = await open();
  const leaks = new Leaks();
  leaks.watch('SRV_KEY', V);
  leaks.watch('secrets password', PW);
  leaks.attach(atlas, page);
  try {
    // No file yet: the first password creates it, and the page says so in the sidebar too.
    await page.goto(`${atlas.url}/#/settings/secrets`);
    await expect(page.getByRole('heading', { name: 'No secrets password yet' })).toBeVisible();
    await expect(page.locator('.sec-badge')).toContainText('Secrets: set a password');
    await page.getByLabel('Password', { exact: false }).first().fill(PW);
    await page.getByLabel('Again').fill(PW);
    await page.getByRole('button', { name: 'Set the password' }).click();
    await expect(page.locator('.sec-store')).toContainText('secrets.enc');
    await expect(page.locator('.sec-badge')).toHaveCount(0);

    await addSecret(page, { name: 'SRV_KEY', value: V, all: true });
    await runTask(atlas, 'Use it, open', 'atlas', sh('echo "k=$SRV_KEY"'));
    expect(toolResults(atlas)[0]).toContain('k=[secret SRV_KEY]');

    // The server restarts: the file is there, encrypted, and the store is locked.
    await atlas.engine.stop();
    atlas = await open();
    leaks.attach(atlas);
    await page.goto(`${atlas.url}/#/settings/secrets`);
    await expect(page.getByRole('heading', { name: 'Secrets are locked' })).toBeVisible();
    await expect(page.locator('.sec-badge')).toContainText('Secrets locked');
    await expect(page.locator('[data-secret=SRV_KEY]')).toContainText('SRV_KEY'); // names are readable, values are not
    await expect(page.getByRole('button', { name: 'Replace value' })).toHaveCount(0);

    // A command that needs the secret stops, with the reason; one that does not, runs.
    await runTask(atlas, 'Use it, locked', 'atlas', sh('echo "k=$SRV_KEY"'), sh('echo free'));
    const locked = toolResults(atlas);
    expect(locked[0]).toMatch(/secret store locked.*\$SRV_KEY/);
    expect(locked[1]).toContain('free');

    // A wrong password is refused and stays locked; the right one opens it.
    await page.getByLabel('Secrets password').fill('not-the-password-1');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.locator('.sec-lock .error-text')).toContainText(/wrong secrets password/);
    await expect(page.getByRole('heading', { name: 'Secrets are locked' })).toBeVisible();
    await page.getByLabel('Secrets password').fill(PW);
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Secrets are locked' })).toHaveCount(0);
    await expect(page.locator('.sec-badge')).toHaveCount(0);
    expect((await atlas.engine.secrets.status()).locked).toBe(false);

    await runTask(atlas, 'Use it, unlocked', 'atlas', sh('echo "k=$SRV_KEY"; printenv SRV_KEY | wc -c'));
    const open1 = toolResults(atlas);
    expect(open1[0]).toContain('k=[secret SRV_KEY]');
    expect(open1[0].trim().split('\n').at(-1)!.trim()).toBe(String(V.length + 1));

    // Lock now: back to locked, the next command stops.
    await page.getByRole('button', { name: 'Lock now' }).click();
    await expect(page.getByRole('heading', { name: 'Secrets are locked' })).toBeVisible();
    expect((await atlas.engine.secrets.status()).locked).toBe(true);
    await runTask(atlas, 'Use it, locked again', 'atlas', sh('echo "k=$SRV_KEY"'));
    expect(toolResults(atlas)[0]).toMatch(/secret store locked/);

    const found = await leaks.findings(atlas);
    expect(found, 'a secret value or the password leaked out of secrets.enc').toEqual([]);
  } finally {
    leaks.detach();
    await atlas.stop();
  }
});
