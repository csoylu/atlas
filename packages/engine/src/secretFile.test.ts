import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eventually } from '../test/kit/index.ts';
import { SECRETS_FILE_CHANGED, SECRETS_LOCKED, SECRETS_WRONG_PASSWORD, SecretFile, SecretsPasswordError, serverSecretStore } from './secretFile.ts';

/** #208: the server's secrets.enc (AES-256-GCM, key = scrypt(password)). Low scrypt cost and no delay unless tested. */
const opts = { N: 2 ** 10, failDelayMs: 0 };
const dir = () => mkdtempSync(join(tmpdir(), 'atlas-enc-'));
const PW = 'correct horse battery';

async function created(o: ConstructorParameters<typeof SecretFile>[1] = opts) {
  const file = join(dir(), 'secrets.enc');
  const s = new SecretFile(file, o);
  await s.unlock(PW, 'ui', true);
  return { s, file };
}

describe('secrets.enc', () => {
  it('round trip: values survive a new process; the file holds no value, no password, mode 0600', async () => {
    const { s, file } = await created();
    s.set('ETHERSCAN_KEY', 'etherscan-value-123456');
    s.set('RPC_URL', 'https://rpc.example/v2/abcdef');
    s.delete('RPC_URL');
    s.set('OTHER', 'other-value-éè');
    const raw = readFileSync(file, 'utf8');
    for (const v of ['etherscan-value', 'abcdef', 'other-value', PW]) expect(raw).not.toContain(v);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const again = new SecretFile(file, opts);
    expect(again.status()).toMatchObject({ kind: 'file', exists: true, locked: true, source: null });
    expect(again.names()).toEqual(['ETHERSCAN_KEY', 'OTHER']); // names readable while locked
    expect(() => again.get('ETHERSCAN_KEY')).toThrow(SECRETS_LOCKED);
    expect(() => again.set('X_Y', 'v')).toThrow(SECRETS_LOCKED);
    expect(() => again.delete('OTHER')).toThrow(SECRETS_LOCKED);
    await again.unlock(PW, 'env');
    expect(again.status()).toMatchObject({ locked: false, source: 'env', error: null });
    expect(again.get('ETHERSCAN_KEY')).toBe('etherscan-value-123456');
    expect(again.get('OTHER')).toBe('other-value-éè');
    again.lockNow();
    expect(again.status()).toMatchObject({ locked: true, source: null });
    expect(() => again.get('OTHER')).toThrow(SECRETS_LOCKED);
  });

  it('no file: unlock refuses, the first password (8+ chars) creates it', async () => {
    const file = join(dir(), 'secrets.enc');
    const s = new SecretFile(file, opts);
    expect(s.status()).toMatchObject({ exists: false, locked: true });
    await expect(s.unlock(PW, 'ui')).rejects.toThrow(/no secrets file yet/);
    await expect(s.unlock('short', 'ui', true)).rejects.toThrow(/8 characters/);
    expect(existsSync(file)).toBe(false);
    await s.unlock(PW, 'ui', true);
    expect(existsSync(file)).toBe(true);
    expect(s.names()).toEqual([]);
  });

  it('wrong password: a clear error after the delay, attempts one at a time; the store stays locked', async () => {
    const { s, file } = await created();
    s.set('A_KEY', 'a-value-12345678');
    const t = new SecretFile(file, { N: 2 ** 10, failDelayMs: 150 });
    const t0 = Date.now();
    const tries = await Promise.allSettled([t.unlock('nope-nope', 'ui'), t.unlock('nope-again', 'ui')]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290); // two delays in a row, not in parallel
    for (const r of tries) {
      expect(r.status).toBe('rejected');
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(SecretsPasswordError);
      expect(String((r as PromiseRejectedResult).reason)).toContain(SECRETS_WRONG_PASSWORD);
    }
    expect(t.status().locked).toBe(true);
    await t.unlock(PW, 'ui');
    expect(t.get('A_KEY')).toBe('a-value-12345678');
  });

  it('a tampered file is refused: data, tag, a name or the cost; never half read', async () => {
    const { s, file } = await created();
    s.set('A_KEY', 'a-value-12345678');
    s.set('B_KEY', 'b-value-12345678');
    const good = readFileSync(file, 'utf8');
    const tamper = (f: (o: Record<string, unknown>) => void) => {
      const o = JSON.parse(good) as Record<string, unknown>;
      f(o);
      writeFileSync(file, JSON.stringify(o));
    };
    const flip = (b64: string) => {
      const b = Buffer.from(b64, 'base64');
      b[0] = b[0]! ^ 1;
      return b.toString('base64');
    };
    const cases: [string, (o: Record<string, unknown>) => void, string | RegExp][] = [
      ['data', (o) => (o.data = flip(o.data as string)), SECRETS_FILE_CHANGED],
      ['tag', (o) => (o.tag = flip(o.tag as string)), SECRETS_FILE_CHANGED],
      ['iv', (o) => (o.iv = flip(o.iv as string)), SECRETS_FILE_CHANGED],
      ['a name', (o) => (o.names = ['A_KEY', 'EVIL_KEY']), SECRETS_FILE_CHANGED],
      ['a dropped name', (o) => (o.names = ['A_KEY']), SECRETS_FILE_CHANGED],
      ['the salt', (o) => ((o.kdf as { salt: string }).salt = flip((o.kdf as { salt: string }).salt)), SECRETS_WRONG_PASSWORD],
      ['the version', (o) => (o.v = 2), /not a version 1 secrets file/],
    ];
    for (const [what, f, err] of cases) {
      tamper(f);
      const t = new SecretFile(file, opts);
      await expect(t.unlock(PW, 'ui'), what).rejects.toThrow(err);
      expect(t.status().locked, what).toBe(true);
    }
    writeFileSync(file, 'not json{');
    await expect(new SecretFile(file, opts).unlock(PW, 'ui')).rejects.toThrow(/not a secrets file/);
    writeFileSync(file, good);
    const ok = new SecretFile(file, opts);
    await ok.unlock(PW, 'ui');
    expect(ok.get('B_KEY')).toBe('b-value-12345678');
  });

  it('change the password: the current one is checked, values re-encrypted with a new salt, the old password stops working', async () => {
    const { s, file } = await created();
    s.set('A_KEY', 'a-value-12345678');
    const before = JSON.parse(readFileSync(file, 'utf8')) as { kdf: { salt: string } };
    await expect(s.changePassword('wrong-one', 'a brand new password')).rejects.toThrow(SECRETS_WRONG_PASSWORD);
    await expect(s.changePassword(PW, 'short')).rejects.toThrow(/8 characters/);
    await s.changePassword(PW, 'a brand new password');
    expect(s.get('A_KEY')).toBe('a-value-12345678');
    const after = JSON.parse(readFileSync(file, 'utf8')) as { kdf: { salt: string } };
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    await expect(new SecretFile(file, opts).unlock(PW, 'ui')).rejects.toThrow(SECRETS_WRONG_PASSWORD);
    const t = new SecretFile(file, opts);
    await t.unlock('a brand new password', 'ui');
    expect(t.get('A_KEY')).toBe('a-value-12345678');
  });

  it('a crash between the temp file and the rename keeps the old file; the leftover temp file goes at the next start', async () => {
    let crash = false;
    const { s, file } = await created({ ...opts, beforeRename: () => { if (crash) throw new Error('killed'); } });
    s.set('A_KEY', 'old-value-12345678');
    crash = true;
    expect(() => s.set('A_KEY', 'new-value-12345678')).toThrow('killed');
    expect(s.get('A_KEY')).toBe('old-value-12345678'); // the memory copy did not move either
    // A real kill leaves the temp file behind: simulate it, then restart.
    writeFileSync(file + '.tmp-999-1', 'half a file');
    const t = new SecretFile(file, opts);
    expect(readdirSync(join(file, '..')).filter((f) => f.includes('.tmp-'))).toEqual([]);
    await t.unlock(PW, 'ui');
    expect(t.get('A_KEY')).toBe('old-value-12345678');
  });

  it('SIGKILL during writes leaves the old or the new file, never a broken one', async () => {
    const file = join(dir(), 'secrets.enc');
    const child = resolve(import.meta.dirname, '../test/secretFile-child.ts');
    const kills = Number(process.env.SECRET_KILLS ?? 5);
    let last = 0;
    let midWrite = 0; // kills that left a temp file: they landed during a write
    for (let i = 0; i < kills; i++) {
      const p = spawn(process.execPath, ['--import', 'tsx', child, file, PW], { stdio: ['ignore', 'pipe', 'inherit'] });
      let printed = 0;
      p.stdout.on('data', (d: Buffer) => {
        const ns = d.toString().trim().split('\n').map(Number).filter(Boolean);
        if (ns.length) printed = ns.at(-1)!;
      });
      await eventually(() => expect(printed).toBeGreaterThan(last), { timeout: 15_000, what: 'the child to write' });
      await new Promise((r) => setTimeout(r, Math.random() * 40)); // kill at a random instant mid-loop
      const exited = new Promise((r) => p.once('exit', r));
      p.kill('SIGKILL');
      await exited;
      if (readdirSync(join(file, '..')).some((f) => f.includes('.tmp-'))) midWrite++;
      const s = new SecretFile(file, opts);
      await s.unlock(PW, 'ui');
      const n = Number(s.get('COUNTER'));
      expect(n).toBeGreaterThanOrEqual(printed); // every completed write is there (the next one may be too)
      expect(n).toBeLessThanOrEqual(printed + 1);
      expect(s.get('PADDING')?.startsWith('xxxx')).toBe(true);
      last = n;
    }
    if (process.env.SECRET_KILLS) console.log(`${midWrite} of ${kills} kills landed during a write`);
  }, 60_000);

  it('serverSecretStore: ATLAS_SECRETS_PASSWORD creates then unlocks; a wrong one starts locked with the error shown', async () => {
    const d = dir();
    const a = await serverSecretStore(d, { ATLAS_SECRETS_PASSWORD: PW }, opts);
    expect(a.status()).toMatchObject({ exists: true, locked: false, source: 'env' });
    a.set('A_KEY', 'a-value-12345678');
    const b = await serverSecretStore(d, { ATLAS_SECRETS_PASSWORD: PW }, opts);
    expect(b.get('A_KEY')).toBe('a-value-12345678');
    const errors: unknown[] = [];
    const orig = console.error;
    console.error = (...x: unknown[]) => void errors.push(x.join(' '));
    try {
      const c = await serverSecretStore(d, { ATLAS_SECRETS_PASSWORD: 'not the password' }, opts);
      expect(c.status()).toMatchObject({ locked: true, error: expect.stringContaining(SECRETS_WRONG_PASSWORD) });
      await c.unlock(PW, 'ui');
      expect(c.status().error).toBeNull();
    } finally {
      console.error = orig;
    }
    expect(String(errors[0])).not.toContain('not the password');
    const none = await serverSecretStore(dir(), {}, opts);
    expect(none.status()).toMatchObject({ exists: false, locked: true, error: null });
  });
});
