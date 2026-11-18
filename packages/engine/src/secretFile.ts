import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SecretStoreStatus } from '@atlas/shared';
import { ConflictError } from './kanban.ts';
import type { SecretLock, SecretStore } from './secrets.ts';

/**
 * Server secret store (#208): `<dataDir>/secrets.enc`, one JSON file encrypted with AES-256-GCM under a key derived from
 * the secrets password by scrypt (random salt per password). node:crypto only.
 *
 * - The password and the derived key live in memory only, from the unlock (ATLAS_SECRETS_PASSWORD at start, or typed in
 *   Settings → Secrets) until Lock now or the end of the process.
 * - Locked, the names are still readable (they are in the clear in the header, as in SQLite, and authenticated as GCM
 *   additional data, so a changed name fails the next unlock); values are not: get/set/delete throw SECRETS_LOCKED.
 * - Every write replaces the whole file atomically: temp file (0600) + fsync + rename + fsync of the folder. A kill at any
 *   instant leaves the old file or the new one, never a broken one; a leftover temp file is removed at the next start.
 */

export const SECRETS_LOCKED = 'secret store locked: unlock it in Settings → Secrets';
export const SECRETS_WRONG_PASSWORD = 'wrong secrets password';
export const SECRETS_FILE_CHANGED = 'secrets.enc was changed outside Atlas (it does not decrypt with the right password): restore it from a backup';
/** First password: long enough that scrypt makes guessing slow. */
export const SECRETS_PASSWORD_MIN = 8;

/** The store refuses: locked, or the file is missing (409 on the API, a clear error on a command or a model). */
export class SecretsLockedError extends ConflictError {
  constructor(message = SECRETS_LOCKED) {
    super(message);
  }
}
/** Wrong password: 403 on the API, after a delay. */
export class SecretsPasswordError extends Error {}

interface Kdf {
  name: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
}
interface FileV1 {
  atlas: 'secrets';
  v: 1;
  kdf: Kdf;
  /** Names of the stored values (no value), authenticated as additional data. */
  names: string[];
  /** HMAC of a constant with the second half of the derived key: tells a wrong password from a changed file. */
  check: string;
  iv: string;
  tag: string;
  data: string;
}

export interface SecretFileOptions {
  /** scrypt cost (default 2^15, about 32 MB and 0.1 s); tests lower it. Stored in the file, read back from it. */
  N?: number;
  /** Delay after a wrong password, against guessing (default 1 s). */
  failDelayMs?: number;
  /** Test hook: runs after the temp file is written, before the rename (a crash there must keep the old file). */
  beforeRename?: () => void;
}

const b64 = (b: Buffer) => b.toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64');
const aad = (f: Pick<FileV1, 'atlas' | 'v' | 'kdf' | 'names' | 'check'>) => Buffer.from(JSON.stringify([f.atlas, f.v, f.kdf, f.names, f.check]));
const CHECK = 'atlas secrets.enc v1';

function derive(password: string, kdf: Kdf): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), unb64(kdf.salt), 64, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * kdf.N * kdf.r }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export class SecretFile implements SecretStore, SecretLock {
  readonly label = 'secrets.enc (password)';
  readonly lock = this;
  /** 64 bytes: AES key, then the check key. Null = locked. */
  private key: Buffer | null = null;
  private kdf: Kdf | null = null;
  private values: Record<string, string> | null = null;
  private since: string;
  private source: 'env' | 'ui' | null = null;
  private error: string | null = null;
  private readonly N: number;
  private readonly failDelayMs: number;
  /** Unlock and password changes, one at a time: parallel guesses wait for each other's delay. */
  private queue: Promise<unknown> = Promise.resolve();
  private writes = 0;

  constructor(
    readonly file: string,
    private opts: SecretFileOptions = {},
  ) {
    this.N = opts.N ?? 2 ** 15;
    this.failDelayMs = opts.failDelayMs ?? 1000;
    this.since = new Date().toISOString();
    // A temp file left by a kill mid-write: the real file is the old or the new one, the temp file is garbage.
    const dir = dirname(file);
    if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.startsWith(basename(file) + '.tmp-')) rmSync(join(dir, f), { force: true });
  }

  // ── SecretStore ────────────────────────────────────────────────────────────────────────────────────────────────

  names(): string[] {
    if (this.values) return Object.keys(this.values);
    const f = this.read();
    return f ? [...f.names] : [];
  }

  get(name: string): string | undefined {
    return this.open()[name];
  }

  set(name: string, value: string): void {
    const next = { ...this.open(), [name]: value };
    this.write(next);
  }

  delete(name: string): void {
    const cur = this.open();
    if (!(name in cur)) return;
    const next = { ...cur };
    delete next[name];
    this.write(next);
  }

  // ── SecretLock ─────────────────────────────────────────────────────────────────────────────────────────────────

  status(): SecretStoreStatus {
    return { kind: 'file', exists: existsSync(this.file), locked: !this.values, since: this.since, source: this.source, error: this.error };
  }

  /**
   * Unlock with the password. No file yet: the password creates it (first use; `create` must be true, so a typo in
   * Settings never makes a second store). Wrong password: SecretsPasswordError after the delay.
   */
  unlock(password: string, source: 'env' | 'ui', create = false): Promise<void> {
    return this.serial(async () => {
      if (!existsSync(this.file)) {
        if (!create) throw new SecretsLockedError('no secrets file yet: set a secrets password first');
        await this.create(password);
      } else {
        const f = this.read()!;
        const key = await derive(password, f.kdf);
        this.values = await this.decrypt(f, key);
        this.key = key;
        this.kdf = f.kdf;
      }
      this.source = source;
      this.since = new Date().toISOString();
      this.error = null;
    });
  }

  lockNow(): void {
    this.key?.fill(0);
    this.key = null;
    this.kdf = null;
    this.values = null;
    this.source = null;
    this.since = new Date().toISOString();
  }

  /** A new password: the current one is checked against the file, then the values are re-encrypted (atomic). */
  changePassword(current: string, next: string): Promise<void> {
    return this.serial(async () => {
      if (next.length < SECRETS_PASSWORD_MIN) throw new ConflictError(`the new password needs ${SECRETS_PASSWORD_MIN} characters or more`);
      const f = this.read();
      if (!f) throw new SecretsLockedError('no secrets file yet: set a secrets password first');
      const values = await this.decrypt(f, await derive(current, f.kdf));
      const kdf: Kdf = { name: 'scrypt', N: this.N, r: 8, p: 1, salt: b64(randomBytes(16)) };
      const key = await derive(next, kdf);
      this.write(values, key, kdf);
      this.key?.fill(0);
      this.key = key;
      this.kdf = kdf;
      this.values = values;
      this.source = 'ui';
      this.since = new Date().toISOString();
      this.error = null;
    });
  }

  /** A failed unlock from ATLAS_SECRETS_PASSWORD at start: shown in the status until an unlock succeeds. */
  fail(message: string): void {
    this.error = message;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async create(password: string): Promise<void> {
    if (password.length < SECRETS_PASSWORD_MIN) throw new ConflictError(`the secrets password needs ${SECRETS_PASSWORD_MIN} characters or more`);
    const kdf: Kdf = { name: 'scrypt', N: this.N, r: 8, p: 1, salt: b64(randomBytes(16)) };
    const key = await derive(password, kdf);
    this.write({}, key, kdf);
    this.key = key;
    this.kdf = kdf;
    this.values = {};
  }

  private open(): Record<string, string> {
    if (!this.values) throw new SecretsLockedError();
    return this.values;
  }

  private read(): FileV1 | null {
    if (!existsSync(this.file)) return null;
    let f: FileV1;
    try {
      f = JSON.parse(readFileSync(this.file, 'utf8')) as FileV1;
    } catch (e) {
      throw new Error(`${this.file} is not a secrets file: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (f.atlas !== 'secrets' || f.v !== 1 || f.kdf?.name !== 'scrypt' || !Array.isArray(f.names))
      throw new Error(`${this.file} is not a version 1 secrets file`);
    return f;
  }

  private async decrypt(f: FileV1, key: Buffer): Promise<Record<string, string>> {
    const check = createHmac('sha256', key.subarray(32)).update(CHECK).digest();
    const given = unb64(f.check);
    if (given.length !== check.length || !timingSafeEqual(given, check)) {
      await new Promise((r) => setTimeout(r, this.failDelayMs));
      throw new SecretsPasswordError(SECRETS_WRONG_PASSWORD);
    }
    let values: Record<string, string>;
    try {
      const d = createDecipheriv('aes-256-gcm', key.subarray(0, 32), unb64(f.iv));
      d.setAAD(aad(f));
      d.setAuthTag(unb64(f.tag));
      values = JSON.parse(Buffer.concat([d.update(unb64(f.data)), d.final()]).toString('utf8')) as Record<string, string>;
    } catch {
      // The right password (the check matched) but the content or the header changed: refused, never half read.
      throw new Error(SECRETS_FILE_CHANGED);
    }
    const names = Object.keys(values);
    if (names.length !== f.names.length || names.some((n, i) => n !== f.names[i])) throw new Error(SECRETS_FILE_CHANGED);
    return values;
  }

  /** The whole file, replaced atomically. Then the in-memory copy (a failed write changes nothing). */
  private write(values: Record<string, string>, key = this.key, kdf = this.kdf): void {
    if (!key || !kdf) throw new SecretsLockedError();
    const iv = randomBytes(12);
    const head = { atlas: 'secrets' as const, v: 1 as const, kdf, names: Object.keys(values), check: b64(createHmac('sha256', key.subarray(32)).update(CHECK).digest()) };
    const c = createCipheriv('aes-256-gcm', key.subarray(0, 32), iv);
    c.setAAD(aad(head));
    const data = Buffer.concat([c.update(JSON.stringify(values), 'utf8'), c.final()]);
    const body: FileV1 = { ...head, iv: b64(iv), tag: b64(c.getAuthTag()), data: b64(data) };
    const tmp = `${this.file}.tmp-${process.pid}-${++this.writes}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(body));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      this.opts.beforeRename?.();
      renameSync(tmp, this.file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    if (process.platform !== 'win32') {
      const dir = openSync(dirname(this.file), 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    }
    this.values = values;
  }
}

/**
 * The server store (main.ts): `<dataDir>/secrets.enc`, unlocked at start when ATLAS_SECRETS_PASSWORD is set (the first
 * start with it creates the file). A wrong password does not stop the engine: the store stays locked, the error is
 * printed and shown in Settings → Secrets, and everything that needs no stored secret keeps working.
 */
export async function serverSecretStore(dataDir: string, env: NodeJS.ProcessEnv, opts: SecretFileOptions = {}): Promise<SecretFile> {
  mkdirSync(dataDir, { recursive: true });
  const store = new SecretFile(join(dataDir, 'secrets.enc'), opts);
  const password = env.ATLAS_SECRETS_PASSWORD;
  if (!password) return store;
  try {
    await store.unlock(password, 'env', true);
  } catch (e) {
    const msg = `ATLAS_SECRETS_PASSWORD did not unlock secrets.enc: ${e instanceof Error ? e.message : String(e)}`;
    console.error(msg);
    store.fail(msg);
  }
  return store;
}
