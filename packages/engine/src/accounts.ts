import { randomUUID } from 'node:crypto';
import { CreateAccount, UpdateAccount, type Account, type AccountLimits, type RateLimit } from '@atlas/shared';
import { ConflictError, NotFoundError } from './kanban.ts';
import type { Db } from './store/db.ts';
import type { SecretStore } from './secrets.ts';
import { AnthropicError, AnthropicProvider } from './providers/anthropic.ts';
import { ModelError, type ModelRequest, type ModelResponse, type Provider } from './providers/types.ts';

/**
 * Anthropic accounts (design §5): several API keys tried in priority order. A call goes to the first enabled
 * account that isn't cooling down; a rate limit, an exhausted quota or a refused key cools that account down (until
 * the reset Anthropic gives, or a fixed pause) and the same call moves to the next one. Every response's rate-limit
 * headers are kept per account, and tokens are counted per account and day, so the UI can show limits and use.
 * Keys live in the keychain (desktop) or the environment (server); the table holds only the variable's name.
 */

interface Row {
  id: string;
  provider: 'anthropic';
  label: string;
  secret: string;
  priority: number;
  enabled: number;
  cooldown_until: string | null;
  last_error: string | null;
  last_used_at: string | null;
  limits: string | null;
  created_at: string;
}

/** Default pause when Anthropic gives no reset time. */
const COOLDOWN_MS = { rate: 60_000, overloaded: 30_000, auth: 30 * 60_000, billing: 60 * 60_000 };

export type ProviderMaker = (key: string, onHeaders: (h: Headers) => void) => Provider;
const realMaker: ProviderMaker = (key, onHeaders) => new AnthropicProvider(key, { maxRetries: 0, onHeaders });

export class Accounts {
  constructor(
    private db: Db,
    private env: NodeJS.ProcessEnv,
    private secrets?: SecretStore,
    private make: ProviderMaker = realMaker,
    private now: () => number = Date.now,
  ) {
    this.seed();
  }

  /** First start with a single key or OAuth token: it becomes the first account. */
  private seed() {
    if (this.db.prepare('SELECT 1 FROM accounts').get()) return;
    const secret = this.env.ANTHROPIC_API_KEY
      ? 'ANTHROPIC_API_KEY'
      : this.env.CLAUDE_CODE_OAUTH_TOKEN
        ? 'CLAUDE_CODE_OAUTH_TOKEN'
        : this.env.ANTHROPIC_TOKEN
          ? 'ANTHROPIC_TOKEN'
          : null;
    if (!secret) return;
    this.db
      .prepare("INSERT INTO accounts (id, provider, label, secret, priority, created_at) VALUES (?, 'anthropic', 'Default', ?, 0, ?)")
      .run('acc_' + randomUUID().slice(0, 8), secret, new Date(this.now()).toISOString());
  }

  private toAccount(r: Row): Account {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const u = this.db.prepare('SELECT calls, input, output FROM account_usage WHERE account_id = ? AND day = ?').get(r.id, day) as
      | { calls: number; input: number; output: number }
      | undefined;
    const cooling = r.cooldown_until && Date.parse(r.cooldown_until) > this.now() ? r.cooldown_until : null;
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      secret: r.secret,
      keyPresent: !!this.env[r.secret],
      priority: r.priority,
      enabled: !!r.enabled,
      cooldownUntil: cooling,
      lastError: r.last_error,
      lastUsedAt: r.last_used_at,
      limits: r.limits ? (JSON.parse(r.limits) as AccountLimits) : null,
      today: u ?? { calls: 0, input: 0, output: 0 },
    };
  }

  list(): Account[] {
    this.seed(); // a key set since start (ANTHROPIC_API_KEY) becomes the first account
    return (this.db.prepare('SELECT * FROM accounts ORDER BY priority, created_at').all() as Row[]).map((r) => this.toAccount(r));
  }
  get(id: string): Account {
    const r = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new NotFoundError(`account ${id} not found`);
    return this.toAccount(r);
  }

  create(input: unknown): Account {
    const c = CreateAccount.parse(input);
    const id = 'acc_' + randomUUID().slice(0, 8);
    const secret = c.key ? 'ANTHROPIC_KEY_' + id.slice(4).toUpperCase() : c.secret;
    if (!secret) throw new ConflictError('give the key, or the name of the env var that holds it');
    if (c.key) this.storeKey(secret, c.key);
    else if (!this.env[secret]) throw new ConflictError(`${secret} is not set in the engine's environment`);
    const priority = c.priority ?? ((this.db.prepare('SELECT MAX(priority) AS m FROM accounts').get() as { m: number | null }).m ?? -1) + 1;
    this.db
      .prepare("INSERT INTO accounts (id, provider, label, secret, priority, created_at) VALUES (?, 'anthropic', ?, ?, ?, ?)")
      .run(id, c.label, secret, priority, new Date(this.now()).toISOString());
    return this.get(id);
  }

  private storeKey(name: string, key: string) {
    if (!this.secrets) throw new ConflictError(`this engine reads keys from its environment: set ${name} there, then add the account with that name`);
    this.secrets.set(name, key);
    this.env[name] = key;
  }

  update(id: string, patch: unknown): Account {
    const p = UpdateAccount.parse(patch);
    const a = this.get(id);
    if (p.key) {
      this.storeKey(a.secret, p.key);
      this.db.prepare('UPDATE accounts SET cooldown_until = NULL, last_error = NULL WHERE id = ?').run(id);
    }
    if (p.label !== undefined) this.db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(p.label, id);
    if (p.priority !== undefined) this.db.prepare('UPDATE accounts SET priority = ? WHERE id = ?').run(p.priority, id);
    if (p.enabled !== undefined) this.db.prepare('UPDATE accounts SET enabled = ?, cooldown_until = NULL WHERE id = ?').run(p.enabled ? 1 : 0, id);
    return this.get(id);
  }

  /** New order, first = tried first: priorities become 0, 1, 2… */
  reorder(ids: string[]): Account[] {
    const all = this.list().map((a) => a.id);
    if (ids.length !== all.length || !all.every((id) => ids.includes(id))) throw new ConflictError('reorder needs every account id once');
    this.db.transaction(() => ids.forEach((id, i) => this.db.prepare('UPDATE accounts SET priority = ? WHERE id = ?').run(i, id)))();
    return this.list();
  }

  remove(id: string): void {
    const a = this.get(id);
    this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    // Our own keychain entry goes with it; an env var named by Can is his.
    if (a.secret.startsWith('ANTHROPIC_KEY_') && this.secrets?.names().includes(a.secret)) {
      this.secrets.delete(a.secret);
      delete this.env[a.secret];
    }
  }

  /** Check the key with a free call (list models); clears a cooldown on success. */
  async test(id: string): Promise<{ ok: boolean; error: string | null }> {
    const a = this.get(id);
    const key = this.env[a.secret];
    if (!key) return { ok: false, error: `${a.secret} is not set` };
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as unknown as Response);
    if (res.ok) {
      this.db.prepare('UPDATE accounts SET cooldown_until = NULL, last_error = NULL WHERE id = ?').run(id);
      return { ok: true, error: null };
    }
    const error = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
    this.db.prepare('UPDATE accounts SET last_error = ? WHERE id = ?').run(error, id);
    return { ok: false, error };
  }

  /** Enabled accounts; throws the reason when none has a key (the dispatcher checks this before starting a run). */
  ready(): Account[] {
    const all = this.list().filter((a) => a.enabled);
    if (!all.length) throw new ModelError('no Anthropic account: add one on the Models page (Anthropic accounts), or set ANTHROPIC_API_KEY');
    if (!all.some((a) => this.env[a.secret])) throw new ModelError(`no key for any Anthropic account (${all.map((a) => a.secret).join(', ')} missing)`);
    return all;
  }

  /** A provider that sends each call to the accounts in order. */
  provider(): Provider {
    this.ready();
    return { complete: (req, onText, signal) => this.complete(req, onText, signal) };
  }

  private async complete(req: ModelRequest, onText: (t: string) => void, signal: AbortSignal): Promise<ModelResponse> {
    const all = this.ready();
    const usable = all.filter((a) => this.env[a.secret] && !a.cooldownUntil);
    if (!usable.length) {
      const next = all.map((a) => a.cooldownUntil).filter(Boolean).sort()[0];
      const why = all.map((a) => `${a.label}: ${!this.env[a.secret] ? 'key missing' : (a.lastError ?? 'cooling down')}`).join('; ');
      throw new ModelError(`every Anthropic account is unavailable (${why})${next ? `; first one back at ${next}` : ''}`, !!next);
    }
    const failures: string[] = [];
    let transient = true;
    for (const a of usable) {
      let streamed = false;
      const provider = this.make(this.env[a.secret]!, (h) => this.recordLimits(a.id, h));
      try {
        const res = await provider.complete(
          req,
          (t) => {
            streamed = true;
            onText(t);
          },
          signal,
        );
        this.recordUse(a.id, res.usage);
        return res;
      } catch (e) {
        if (signal.aborted) throw e;
        const kind = classify(e);
        // Text already reached the chat, or the request itself is wrong: don't replay it on another account.
        if (streamed || !kind) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        this.coolDown(a.id, kind, e instanceof AnthropicError ? e.headers : null, msg);
        failures.push(`${a.label}: ${msg}`);
        if (kind === 'auth' || kind === 'billing') transient = false;
      }
    }
    throw new ModelError(`every Anthropic account failed: ${failures.join(' | ')}`, transient);
  }

  private coolDown(id: string, kind: keyof typeof COOLDOWN_MS, headers: Headers | null, error: string) {
    let until = this.now() + COOLDOWN_MS[kind];
    const retry = headers?.get('retry-after');
    if (retry && Number.isFinite(Number(retry))) until = this.now() + Number(retry) * 1000;
    else if (kind === 'rate') {
      const resets = ['requests', 'input-tokens', 'output-tokens', 'tokens']
        .map((k) => headers?.get(`anthropic-ratelimit-${k}-reset`))
        .filter((v): v is string => !!v)
        .map((v) => Date.parse(v))
        .filter((t) => t > this.now());
      if (resets.length) until = Math.max(...resets);
    }
    this.db.prepare('UPDATE accounts SET cooldown_until = ?, last_error = ? WHERE id = ?').run(new Date(until).toISOString(), error.slice(0, 500), id);
  }

  private recordLimits(id: string, h: Headers) {
    const read = (k: string): RateLimit | null => {
      const limit = h.get(`anthropic-ratelimit-${k}-limit`);
      const remaining = h.get(`anthropic-ratelimit-${k}-remaining`);
      if (limit === null || remaining === null) return null;
      return { limit: Number(limit), remaining: Number(remaining), reset: h.get(`anthropic-ratelimit-${k}-reset`) };
    };
    const limits: AccountLimits = {
      requests: read('requests'),
      input: read('input-tokens'),
      output: read('output-tokens'),
      tokens: read('tokens'),
      at: new Date(this.now()).toISOString(),
    };
    if (!limits.requests && !limits.input && !limits.output && !limits.tokens) return;
    this.db.prepare('UPDATE accounts SET limits = ? WHERE id = ?').run(JSON.stringify(limits), id);
  }

  private recordUse(id: string, usage: { input: number; output: number }) {
    const now = new Date(this.now()).toISOString();
    this.db.transaction(() => {
      this.db.prepare('UPDATE accounts SET last_used_at = ?, last_error = NULL, cooldown_until = NULL WHERE id = ?').run(now, id);
      this.db
        .prepare(
          `INSERT INTO account_usage (account_id, day, calls, input, output) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(account_id, day) DO UPDATE SET calls = calls + 1, input = input + excluded.input, output = output + excluded.output`,
        )
        .run(id, now.slice(0, 10), usage.input, usage.output);
    })();
  }
}

/** Which failures move the call to the next account. null: the request itself is at fault, retrying elsewhere won't help. */
function classify(e: unknown): keyof typeof COOLDOWN_MS | null {
  if (!(e instanceof AnthropicError)) return e instanceof ModelError && e.transient ? 'overloaded' : null;
  const s = e.status;
  if (s === 429) return 'rate';
  if (s === 401 || s === 403) return 'auth';
  if (s === 402 || (s === 400 && /credit balance|billing|spend limit|usage limit/i.test(e.message))) return 'billing';
  if (s === undefined || s === 529 || s >= 500) return 'overloaded';
  return null;
}
