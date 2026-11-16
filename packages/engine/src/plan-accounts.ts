import { randomUUID } from 'node:crypto';
import {
  CHATGPT_USAGE_URL,
  CreatePlanAccount,
  UpdatePlanAccount,
  type PlanAccount,
  type PlanProvider,
  type PlanQuota,
  type PlanWindow,
} from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import type { SecretStore } from './secrets.ts';
import type { Notifications } from './notifications.ts';
import { ConflictError, NotFoundError } from './kanban.ts';
import { ModelError, type ModelResponse } from './providers/types.ts';

/**
 * Plan subscriptions (design §5, 11 Nov 2026): several Claude plan and ChatGPT plan sign-ins, each with its own
 * name and keychain entry. Calls go to the signed-in accounts in list order; one that reaches its usage limit is
 * paused (until the reset the provider gives, or until Resume) and the same call moves to the next one, and the user is
 * notified. When all are paused the call fails with the earliest reset, and the card waits until then.
 */
export interface PlanRow {
  id: string;
  provider: PlanProvider;
  label: string;
  position: number;
  secret: string;
  client_id: string | null;
  subject: string | null;
  email: string | null;
  scopes: string | null;
  expires_at: string | null;
  signed_in_at: string | null;
  last_used_at: string | null;
  paused_at: string | null;
  paused_until: string | null;
  last_error: string | null;
  quota: string | null;
  quota_raw: string | null;
  created_at: string;
}

/** A usage limit: pause this account (until `until`, ms; null = until Resume) and try the next one. */
export class PlanLimitError extends ModelError {
  constructor(
    message: string,
    readonly until: number | null,
  ) {
    super(message, true);
  }
}

const NAME: Record<PlanProvider, string> = { claude_plan: 'Claude', chatgpt: 'ChatGPT' };
/** Keychain entry of the first account of each provider (the single sign-in before 0020 kept it). */
const FIRST_SECRET: Record<PlanProvider, string> = { claude_plan: 'CLAUDE_TOKENS', chatgpt: 'CHATGPT_TOKENS' };


const hhmm = (ms: number) => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export class PlanAccounts {
  constructor(
    private db: Db,
    private bus: Bus,
    private secrets: SecretStore | undefined,
    private notifications: Notifications,
    private now: () => number = Date.now,
  ) {}

  /** Tell the UI a provider's accounts changed (set by the Claude / ChatGPT classes). */
  onChange: Partial<Record<PlanProvider, () => void>> = {};
  private changed(p: PlanProvider) {
    this.onChange[p]?.();
  }

  rows(provider: PlanProvider): PlanRow[] {
    return this.db.prepare('SELECT * FROM plan_accounts WHERE provider = ? ORDER BY position, created_at').all(provider) as PlanRow[];
  }
  row(id: string): PlanRow {
    const r = this.db.prepare('SELECT * FROM plan_accounts WHERE id = ?').get(id) as PlanRow | undefined;
    if (!r) throw new NotFoundError(`subscription ${id} not found`);
    return r;
  }
  /** Label and quota of an account, null if it was removed (the composer's « of 5h » gauge). */
  find(id: string): { provider: PlanProvider; label: string; quota: PlanQuota | null } | null {
    const r = this.db.prepare('SELECT * FROM plan_accounts WHERE id = ?').get(id) as PlanRow | undefined;
    return r ? { provider: r.provider, label: r.label, quota: r.quota ? (JSON.parse(r.quota) as PlanQuota) : null } : null;
  }
  set(id: string, cols: Partial<PlanRow>): void {
    const keys = Object.keys(cols);
    if (keys.length) this.db.prepare(`UPDATE plan_accounts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...cols, id });
  }
  tokens<T>(r: PlanRow): T | null {
    const raw = this.secrets?.get(r.secret);
    return raw ? (JSON.parse(raw) as T) : null;
  }
  setTokens(r: PlanRow, t: unknown): void {
    this.secrets!.set(r.secret, JSON.stringify(t));
  }
  dropTokens(r: PlanRow): void {
    if (this.secrets?.get(r.secret) !== undefined) this.secrets.delete(r.secret);
  }

  /** Paused now: since paused_at, until paused_until (NULL = until Resume). An ended pause no longer counts. */
  paused(r: PlanRow): boolean {
    return !!r.paused_at && (!r.paused_until || Date.parse(r.paused_until) > this.now());
  }

  view(r: PlanRow, signedIn: boolean, planUsage = signedIn): PlanAccount {
    const paused = this.paused(r);
    return {
      id: r.id,
      provider: r.provider,
      label: r.label,
      position: r.position,
      signedIn,
      email: r.email,
      planUsage,
      paused,
      pausedUntil: paused ? r.paused_until : null,
      lastError: r.last_error,
      lastUsedAt: r.last_used_at,
      quota: r.quota ? (JSON.parse(r.quota) as PlanQuota) : null,
    };
  }

  create(input: unknown): PlanRow {
    const c = CreatePlanAccount.parse(input);
    if (!this.secrets) throw new ConflictError(`${NAME[c.provider]} sign-in works in the desktop app: a server engine has no keychain to keep the tokens in.`);
    if (this.rows(c.provider).some((r) => r.label.toLowerCase() === c.label.toLowerCase())) throw new ConflictError(`there is already a ${NAME[c.provider]} subscription named ${c.label}`);
    const id = 'pa_' + randomUUID().slice(0, 8);
    const taken = (this.db.prepare('SELECT 1 FROM plan_accounts WHERE secret = ?').get(FIRST_SECRET[c.provider]) as unknown) || this.secrets.get(FIRST_SECRET[c.provider]);
    const secret = taken ? `${FIRST_SECRET[c.provider]}_${id.slice(3).toUpperCase()}` : FIRST_SECRET[c.provider];
    const position = ((this.db.prepare('SELECT MAX(position) AS m FROM plan_accounts WHERE provider = ?').get(c.provider) as { m: number | null }).m ?? -1) + 1;
    this.db
      .prepare('INSERT INTO plan_accounts (id, provider, label, position, secret, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, c.provider, c.label, position, secret, new Date(this.now()).toISOString());
    this.changed(c.provider);
    return this.row(id);
  }

  /** The account a sign-in is for: the given one, else the first one, made (« Main ») when there is none. */
  forLogin(provider: PlanProvider, id?: string | null): PlanRow {
    if (id) {
      const r = this.row(id);
      if (r.provider !== provider) throw new ConflictError(`${id} is not a ${NAME[provider]} subscription`);
      return r;
    }
    return this.rows(provider)[0] ?? this.create({ provider, label: 'Main' });
  }

  update(id: string, patch: unknown): PlanRow {
    const p = UpdatePlanAccount.parse(patch);
    const r = this.row(id);
    if (p.label !== undefined) {
      if (this.rows(r.provider).some((o) => o.id !== id && o.label.toLowerCase() === p.label!.toLowerCase()))
        throw new ConflictError(`there is already a ${NAME[r.provider]} subscription named ${p.label}`);
      this.set(id, { label: p.label });
    }
    if (p.resume) this.set(id, { paused_at: null, paused_until: null, last_error: null });
    this.changed(r.provider);
    return this.row(id);
  }

  /** New order for one provider, first = tried first. */
  reorder(provider: PlanProvider, ids: string[]): void {
    const all = this.rows(provider).map((r) => r.id);
    if (ids.length !== all.length || !all.every((id) => ids.includes(id))) throw new ConflictError('reorder needs every subscription id of that provider once');
    this.db.transaction(() => ids.forEach((id, i) => this.set(id, { position: i })))();
    this.changed(provider);
  }

  /** Forget an account (the caller signed it out first). */
  remove(id: string): void {
    const r = this.row(id);
    this.dropTokens(r);
    this.db.prepare('DELETE FROM plan_accounts WHERE id = ?').run(id);
    this.changed(r.provider);
  }

  /** Store the usage windows a response reported (nothing when it reported none). */
  recordQuota(id: string, quota: PlanQuota | null, raw: Record<string, string>): void {
    const cols: Partial<PlanRow> = {};
    if (Object.keys(raw).length) cols.quota_raw = JSON.stringify(raw);
    if (quota) cols.quota = JSON.stringify(quota);
    if (!Object.keys(cols).length) return;
    const r = this.row(id);
    this.set(id, cols);
    if (quota) this.changed(r.provider);
  }

  /**
   * One model call on the provider's accounts, in order: the first usable one answers; a usage limit pauses it and
   * the call moves on (the user is notified). Text already streamed is never replayed on another account.
   */
  async call(
    provider: PlanProvider,
    usable: (r: PlanRow) => boolean,
    attempt: (r: PlanRow, onStream: () => void) => Promise<ModelResponse>,
  ): Promise<ModelResponse> {
    const all = this.rows(provider).filter(usable);
    if (!all.length) throw new ModelError(`${NAME[provider]} plan: not signed in. Sign in in Settings → Subscriptions.`);
    const open = all.filter((r) => !this.paused(r));
    if (!open.length) throw this.exhausted(provider, all);
    for (let i = 0; i < open.length; i++) {
      const a = open[i]!;
      let streamed = false;
      try {
        const res = await attempt(a, () => (streamed = true));
        this.set(a.id, { last_used_at: new Date(this.now()).toISOString(), last_error: null, paused_at: null, paused_until: null });
        return { ...res, account: a.id };
      } catch (e) {
        if (!(e instanceof PlanLimitError)) throw e;
        this.pause(a, e);
        const next = open[i + 1];
        const reset = e.until ? ` (resets ${hhmm(e.until)})` : '';
        if (next) {
          this.notifications.create({
            kind: 'plan.switched',
            title: `${NAME[provider]} · ${a.label} reached its usage limit`,
            body: `${a.label} is paused${reset}. Work moved to ${next.label}.`,
          });
          if (!streamed) continue;
          // Text already reached the chat: not replayed here; the retry goes to the next account.
          throw new ModelError(`${NAME[provider]} · ${a.label} reached its usage limit mid-answer; retrying on ${next.label}`, true);
        }
        const err = this.exhausted(provider, this.rows(provider).filter(usable));
        this.notifications.create({ kind: 'plan.exhausted', title: `Every ${NAME[provider]} subscription reached its limit`, body: err.message });
        throw err;
      }
    }
    throw this.exhausted(provider, all);
  }

  private pause(a: PlanRow, e: PlanLimitError): void {
    this.set(a.id, {
      paused_at: new Date(this.now()).toISOString(),
      paused_until: e.until ? new Date(e.until).toISOString() : null,
      last_error: e.message,
    });
    this.changed(a.provider);
  }

  /** Every account is paused: wait for the earliest reset (transient, with the time), or for Resume when none is known. */
  exhausted(provider: PlanProvider, all: PlanRow[]): ModelError {
    const until = all
      .filter((r) => this.paused(r) && r.paused_until)
      .map((r) => Date.parse(r.paused_until!))
      .sort((a, b) => a - b)[0];
    const who = all.map((r) => r.label).join(', ');
    if (until) {
      const e = new ModelError(`every ${NAME[provider]} subscription reached its usage limit (${who}); work waits until ${hhmm(until)}`, true);
      e.retryAt = new Date(until).toISOString();
      return e;
    }
    const hint = provider === 'chatgpt' ? ` (review usage at ${CHATGPT_USAGE_URL})` : '';
    return new ModelError(`every ${NAME[provider]} subscription reached its usage limit (${who}) and gave no reset time: Resume one in Settings → Subscriptions${hint}`);
  }

  /** The earliest reset when every usable account is paused, else null (for the provider's status). */
  allPausedUntil(provider: PlanProvider, usable: (r: PlanRow) => boolean): { paused: boolean; until: string | null; since: string | null } {
    const all = this.rows(provider).filter(usable);
    if (!all.length || all.some((r) => !this.paused(r))) return { paused: false, until: null, since: null };
    const e = this.exhausted(provider, all);
    return { paused: true, until: e.retryAt ?? null, since: all.map((r) => r.paused_at!).sort()[0] ?? null };
  }

  welcomed(provider: PlanProvider): boolean {
    return !!this.db.prepare('SELECT 1 FROM settings WHERE key = ?').get(provider === 'claude_plan' ? 'claude_welcomed' : 'chatgpt_welcomed');
  }
  setWelcomed(provider: PlanProvider): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(provider === 'claude_plan' ? 'claude_welcomed' : 'chatgpt_welcomed');
  }
  /** A small machine-wide value kept in settings (ChatGPT's host id). */
  setting(key: string, make: () => string): string {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (r) return r.value;
    const v = make();
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, v);
    return v;
  }
}

/* ── Reading quotas from response headers ─────────────────────────────────── */

/** A reset value: unix seconds, unix ms, or a date. */
function resetTime(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}
/** Utilization: Anthropic sends a fraction (0.62); a value above 1.5 is taken as a percentage already. */
function pct(v: string | null): number | null {
  if (v === null || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n > 1.5 ? n : n * 100));
}

/** Header names worth keeping raw, to check what a provider really sends. */
const RAW = /ratelimit|rate-limit|usage|quota|codex|limit/i;
export function rawLimitHeaders(h: Headers | null): Record<string, string> {
  const out: Record<string, string> = {};
  h?.forEach((v, k) => {
    if (RAW.test(k)) out[k] = v;
  });
  return out;
}

/**
 * Claude plan windows: `anthropic-ratelimit-unified-5h-utilization` / `-5h-reset` and `-7d-…` (utilization a
 * fraction, reset unix seconds), plus `anthropic-ratelimit-unified-status`.
 */
export function claudeQuota(h: Headers | null, now: number): PlanQuota | null {
  if (!h) return null;
  const win = (k: string): PlanWindow | null => {
    const used = pct(h.get(`anthropic-ratelimit-unified-${k}-utilization`));
    if (used === null) return null;
    const reset = resetTime(h.get(`anthropic-ratelimit-unified-${k}-reset`));
    return { usedPct: Math.round(used * 10) / 10, resetsAt: reset ? new Date(reset).toISOString() : null };
  };
  const fiveHour = win('5h');
  const week = win('7d');
  const status = h.get('anthropic-ratelimit-unified-status');
  if (!fiveHour && !week && !status) return null;
  return { fiveHour, week, status, at: new Date(now).toISOString() };
}

/** When a Claude plan 429 ends: retry-after, else the reset of the rejected unified window, else the overall reset. */
export function claudeLimitUntil(h: Headers | null, now: number, fallbackMs = 60_000): number {
  const retry = Number(h?.get('retry-after'));
  if (retry > 0) return now + retry * 1000;
  if (h) {
    const rejected = ['5h', '7d', '7d_opus', '7d_sonnet']
      .filter((k) => h.get(`anthropic-ratelimit-unified-${k}-status`) === 'rejected')
      .map((k) => resetTime(h.get(`anthropic-ratelimit-unified-${k}-reset`)))
      .filter((t): t is number => !!t && t > now);
    if (rejected.length) return Math.max(...rejected);
    const overall = resetTime(h.get('anthropic-ratelimit-unified-reset'));
    if (overall && overall > now) return overall;
    let latest = 0;
    h.forEach((v, k) => {
      if (!k.startsWith('anthropic-ratelimit-') || k.startsWith('anthropic-ratelimit-unified-') || !k.endsWith('-reset')) return;
      const t = resetTime(v) ?? 0;
      if (t > latest) latest = t;
    });
    if (latest > now) return latest;
  }
  return now + fallbackMs;
}

/**
 * ChatGPT plan windows, if OpenAI sends them: the Codex-style `x-codex-primary-used-percent`,
 * `-window-minutes`, `-reset-after-seconds` / `-reset-at` (and `secondary`). A 300-minute window is the 5-hour one,
 * a 10080-minute window the week; without window sizes, primary = 5 h and secondary = week.
 */
export function chatgptQuota(h: Headers | null, now: number): PlanQuota | null {
  if (!h) return null;
  const read = (which: 'primary' | 'secondary') => {
    const used = pct(h.get(`x-codex-${which}-used-percent`));
    if (used === null) return null;
    const after = Number(h.get(`x-codex-${which}-reset-after-seconds`));
    const at = resetTime(h.get(`x-codex-${which}-reset-at`));
    const reset = after > 0 ? now + after * 1000 : at;
    return { minutes: Number(h.get(`x-codex-${which}-window-minutes`)) || null, w: { usedPct: Math.round(used * 10) / 10, resetsAt: reset ? new Date(reset).toISOString() : null } };
  };
  const p = read('primary');
  const s = read('secondary');
  if (!p && !s) return null;
  let fiveHour: PlanWindow | null = null;
  let week: PlanWindow | null = null;
  for (const [x, dflt] of [
    [p, 'five'],
    [s, 'week'],
  ] as const) {
    if (!x) continue;
    const isWeek = x.minutes ? x.minutes >= 24 * 60 : dflt === 'week';
    if (isWeek) week = x.w;
    else fiveHour = x.w;
  }
  return { fiveHour, week, status: null, at: new Date(now).toISOString() };
}
