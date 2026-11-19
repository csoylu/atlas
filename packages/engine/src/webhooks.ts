import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WEBHOOK_MAX_BYTES } from '@atlas/shared';
import { InvalidError } from './kanban.ts';
import { isHookEntry, type SecretStore } from './secrets.ts';
import type { Db } from './store/db.ts';

/**
 * Webhook tokens (#260). A webhook trigger's URL is /hook/<token>: the token is the credential, so it lives in the
 * secret store (keychain on the desktop, secrets.enc on a server; rule 5) as `hook:<…>`, hidden from every output by
 * the redactor (Secrets.values), never given to an agent's shell. SQLite keeps its sha256, to find the workflow of a
 * call without reading the store (a locked server store still answers calls).
 *
 * Store writes are not part of the SQLite transaction: a new token's entry is written first, under a name of its own,
 * and an entry no row points to any more (a kill in between, a regenerated or deleted hook) is swept after the
 * commit and at each start.
 */
export class HookTokens {
  constructor(
    private db: Db,
    private store: SecretStore | undefined,
  ) {}

  /** The workflow has a token (inside the save's transaction): made now if it has none. */
  ensure(workflowId: string, now: string): void {
    if (this.db.prepare('SELECT 1 FROM workflow_hooks WHERE workflow_id = ?').get(workflowId)) return;
    const { hash, secret } = this.make();
    this.db.prepare('INSERT INTO workflow_hooks (workflow_id, token_hash, secret, created_at) VALUES (?, ?, ?, ?)').run(workflowId, hash, secret, now);
  }

  /** A new token: the old URL stops working at once (inside a transaction). */
  regenerate(workflowId: string, now: string): void {
    const { hash, secret } = this.make();
    const r = this.db
      .prepare('UPDATE workflow_hooks SET token_hash = ?, secret = ?, created_at = ?, seen_port = NULL, last_at = NULL, last_result = NULL, last_reason = NULL, last_run = NULL, last_body = NULL WHERE workflow_id = ?')
      .run(hash, secret, now, workflowId);
    if (!r.changes) throw new InvalidError(`workflow ${workflowId} has no webhook trigger`);
  }

  /** The trigger is no webhook any more (inside a transaction); its store entry goes at the next sweep. */
  drop(workflowId: string): void {
    this.db.prepare('DELETE FROM workflow_hooks WHERE workflow_id = ?').run(workflowId);
  }

  /** The workflow a token opens, or null (compared by hash: the token is never in SQLite). */
  find(token: string): string | null {
    if (!/^wh_[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
    const r = this.db.prepare('SELECT workflow_id FROM workflow_hooks WHERE token_hash = ?').get(sha(token)) as { workflow_id: string } | undefined;
    return r?.workflow_id ?? null;
  }

  /** The token, for Master's trigger panel; null while a server store is locked. */
  token(workflowId: string): string | null {
    const r = this.db.prepare('SELECT secret FROM workflow_hooks WHERE workflow_id = ?').get(workflowId) as { secret: string } | undefined;
    if (!r || !this.store || this.store.lock?.status().locked) return null;
    return this.store.get(r.secret) ?? null;
  }

  /** Delete the store entries no workflow points to (after a commit, and at start). A locked store waits. */
  sweep(): void {
    if (!this.store || this.store.lock?.status().locked) return;
    const used = new Set((this.db.prepare('SELECT secret FROM workflow_hooks').all() as { secret: string }[]).map((r) => r.secret));
    for (const n of this.store.names()) if (isHookEntry(n) && !used.has(n)) this.store.delete(n);
  }

  private make(): { hash: string; secret: string } {
    if (!this.store) throw new InvalidError('a webhook keeps its token in the secret store, and this engine has none');
    if (this.store.lock?.status().locked) throw new InvalidError('the secret store is locked: unlock it in Settings → Secrets to make a webhook URL');
    const token = 'wh_' + randomBytes(24).toString('base64url');
    const hash = sha(token);
    const secret = 'hook:' + hash.slice(0, 16);
    this.store.set(secret, token);
    return { hash, secret };
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Fields a payload gives a run at most, and the length of each value (longer ones are cut, marked …). */
export const PAYLOAD_MAX_FIELDS = 200;
export const PAYLOAD_MAX_VALUE = 4_000;

/**
 * A JSON body as run fields (#260): `payload` = the whole body (cut), and `payload.<path>` for each value inside it
 * (objects by key, arrays by index: payload.commits.0.id). Numbers and booleans as text, null as an empty text.
 */
export function payloadFields(body: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = { payload: cutText(JSON.stringify(body)) };
  let n = 0;
  const walk = (v: unknown, path: string, depth: number) => {
    if (n >= PAYLOAD_MAX_FIELDS) return;
    if (v !== null && typeof v === 'object') {
      if (depth >= 8) return;
      for (const [k, x] of Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)) if (/^[^.\s]{1,100}$/.test(k)) walk(x, `${path}.${k}`, depth + 1);
      return;
    }
    out[path] = v === null || v === undefined ? '' : cutText(String(v));
    n++;
  };
  walk(body, 'payload', 0);
  return out;
}

const cutText = (s: string) => (s.length > PAYLOAD_MAX_VALUE ? s.slice(0, PAYLOAD_MAX_VALUE - 1) + '…' : s);

/** Why a body is refused (HTTP status and a sentence), or the JSON object it holds. */
export type HookBody = { ok: true; body: Record<string, unknown>; text: string } | { ok: false; status: 400 | 413 | 415; error: string };

/**
 * Read a webhook call's body: JSON only (Content-Type application/json or +json), WEBHOOK_MAX_BYTES at most (the
 * reading stops there), an object at the top. Nothing of a refused body is kept.
 */
export async function readHookBody(req: IncomingMessage): Promise<HookBody> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json' && !/^application\/[\w.-]+\+json$/.test(type)) {
    req.resume();
    return { ok: false, status: 415, error: 'send JSON (Content-Type: application/json)' };
  }
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > WEBHOOK_MAX_BYTES) {
    req.resume();
    return { ok: false, status: 413, error: `the body is larger than ${WEBHOOK_MAX_BYTES / 1024} KB` };
  }
  const text = await new Promise<string | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (c: Buffer) => {
      size += c.length;
      if (size <= WEBHOOK_MAX_BYTES) return void chunks.push(c);
      // Too large: stop keeping it, let the rest drain unread, answer now.
      chunks.length = 0;
      req.off('data', onData);
      req.resume();
      resolve(null);
    };
    req.on('data', onData);
    req.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.once('error', reject);
  });
  if (text === null) return { ok: false, status: 413, error: `the body is larger than ${WEBHOOK_MAX_BYTES / 1024} KB` };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, error: 'the body is not valid JSON' };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false, status: 400, error: 'the body must be a JSON object, like {"ref": "refs/heads/main"}' };
  return { ok: true, body: body as Record<string, unknown>, text };
}
