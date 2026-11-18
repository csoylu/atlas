import { CreateSecret, UpdateSecret, type SecretGrant, type SecretInfo, type SecretKind, type SecretList, type SecretsPassword, type SecretStoreStatus } from '@atlas/shared';
import type { Bus } from './events.ts';
import { ConflictError, NotFoundError } from './kanban.ts';
import type { Db } from './store/db.ts';
import type { Kanban } from './kanban.ts';

/**
 * Where model keys come from (CLAUDE.md rule 5). The desktop app passes a store backed by the OS keychain
 * (Electron safeStorage); a server reads keys from its environment only. Values never go to SQLite, logs or the UI.
 */
export interface SecretStore {
  /** Names of stored secrets (never values). */
  names(): string[];
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  /** Shown in Settings, e.g. 'macOS Keychain'. */
  readonly label: string;
  /**
   * Server store (secrets.enc, #208): values need a password. Locked, names() still answers, get/set/delete throw
   * « secret store locked ». Absent: the store is always open (the desktop keychain).
   */
  readonly lock?: SecretLock;
}

export interface SecretLock {
  status(): SecretStoreStatus;
  /** create: no file yet, this password makes it. */
  unlock(password: string, source: 'env' | 'ui', create?: boolean): Promise<void>;
  lockNow(): void;
  changePassword(current: string, next: string): Promise<void>;
}

/** Same text as secretFile.ts SECRETS_LOCKED (kept here so this file needs no import from it). */
const LOCKED = 'secret store locked: unlock it in Settings → Secrets';
const isLocked = (store?: SecretStore) => !!store?.lock?.status().locked;

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
/**
 * Plan sign-in tokens (plan-accounts.ts): CLAUDE_TOKENS / CHATGPT_TOKENS for each provider's first subscription,
 * CLAUDE_TOKENS_<ID> / CHATGPT_TOKENS_<ID> for the others. Never in the engine env, the key list or the API.
 */
export const isTokenEntry = (name: string) => /^(CLAUDE|CHATGPT)_TOKENS(_[A-Z0-9]+)?$/.test(name);

/** Engine env = process env + stored secrets; setting a secret updates it live (models read it at each call). */
export function envWithSecrets(base: NodeJS.ProcessEnv, store?: SecretStore): NodeJS.ProcessEnv {
  const env = { ...base };
  if (isLocked(store)) return env; // a locked server store: its values arrive at the unlock (Secrets.unlock)
  for (const n of store?.names() ?? []) if (!isTokenEntry(n)) env[n] = store!.get(n);
  return env;
}

// ── Secrets (#206): metadata in SQLite, values in the store, given to agents' shells, hidden from every output ──────

/** Values shorter than this are not hidden (they would match everywhere); the UI says so. */
export const REDACT_MIN = 8;
/** Never in an agent's shell, even when the engine's own environment has them (server mode). */
const ENGINE_ONLY = ['ATLAS_PASSWORD', 'ATLAS_SECRETS_PASSWORD', 'ATLAS_CLAUDE_CLIENT_SECRET'];

/** Variables a shell relies on: a secret by that name would replace them. */
const RESERVED = ['PATH', 'HOME', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'PWD', 'LANG', 'TERM', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME'];

interface SecretRow {
  name: string;
  description: string;
  kind: SecretKind;
  grant_to: SecretGrant;
  agents: string;
  project: string | null;
  created_by: string;
  created_card: string | null;
  created_at: string;
  updated_at: string;
  updated_by: string;
  last_used_at: string | null;
  last_used_by: string | null;
  waiting_card: string | null;
}

/** Who writes: 'user' (Settings) or an agent id, and the task it worked on. */
export interface SecretActor {
  by: string;
  card?: string | null;
}

/** `$NAME` or `${NAME}` (also `${NAME:-x}`) in a command. */
const mentions = (command: string, name: string) => new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`).test(command);

export class Secrets {
  constructor(
    private db: Db,
    private bus: Bus,
    readonly store: SecretStore | undefined,
    /** The engine's environment (server mode: model keys come from it). Stored values are copied in while unlocked. */
    private env: NodeJS.ProcessEnv,
    /** The environment the engine started with: what a name gets back when a lock takes the stored value away. */
    private base: NodeJS.ProcessEnv = {},
    /** For « needs secret X » (#207): the waiting task goes back to work once the value is there. */
    private kanban?: Kanban,
  ) {}

  // ── Lock (#208, server secrets.enc) ─────────────────────────────────────────────────────────────────────────────

  status(): SecretStoreStatus {
    if (!this.store) return { kind: 'env', exists: false, locked: false, since: null, source: null, error: null };
    if (!this.store.lock) return { kind: 'keychain', exists: true, locked: false, since: null, source: null, error: null };
    return this.store.lock.status();
  }

  locked(): boolean {
    return isLocked(this.store);
  }

  private needLock() {
    const lock = this.store?.lock;
    if (!lock) throw new ConflictError(this.store ? `${this.store.label} has no password: it is open while you are signed in to this computer` : 'this engine has no secret store: its keys come from its environment');
    return lock;
  }

  /** Stored values into the engine env (models read their keys there at each call), or out of it when locked. */
  private syncEnv(): void {
    const locked = this.locked();
    for (const n of this.store?.names() ?? []) {
      if (isTokenEntry(n)) continue;
      if (!locked) this.env[n] = this.store!.get(n);
      else if (this.base[n] !== undefined) this.env[n] = this.base[n];
      else delete this.env[n];
    }
  }

  private changed(): void {
    this.syncEnv();
    if (!this.locked()) this.sync();
    this.bus.emit({ type: 'secrets.status', status: this.status() });
    this.bus.emit({ type: 'secrets.updated' });
    this.resume();
  }

  async unlock(password: string, source: 'env' | 'ui' = 'ui'): Promise<SecretStoreStatus> {
    await this.needLock().unlock(password, source);
    this.changed();
    return this.status();
  }

  lockNow(): SecretStoreStatus {
    this.needLock().lockNow();
    this.changed();
    return this.status();
  }

  /** No file yet: `next` creates it (no `current`). Else the current password, checked, then re-encryption. */
  async setPassword(p: SecretsPassword): Promise<SecretStoreStatus> {
    const lock = this.needLock();
    if (!lock.status().exists) {
      if (p.current !== undefined) throw new ConflictError('there is no secrets file yet: leave the current password empty');
      await lock.unlock(p.next, 'ui', true);
    } else {
      if (p.current === undefined) throw new ConflictError('give the current secrets password');
      await lock.changePassword(p.current, p.next);
    }
    this.changed();
    return this.status();
  }

  /**
   * Names held by a locked store (null when it is open): a model whose key is one of them and missing from the
   * environment stops with « secret store locked ».
   */
  lockedNames(): Set<string> | null {
    return this.locked() ? new Set(this.store!.names()) : null;
  }

  /** Env names of model credentials: models' credential_env and Anthropic accounts' keys. */
  private modelKeyNames(): string[] {
    return (
      this.db
        .prepare("SELECT credential_env AS n FROM models WHERE credential_env IS NOT NULL UNION SELECT secret AS n FROM accounts")
        .all() as { n: string }[]
    ).map((r) => r.n);
  }

  private stored(): Set<string> {
    return new Set(this.store?.names() ?? []);
  }

  /**
   * Rows for what is in the store (rule 2: the store and SQLite are two writes). A stored name without a row is a model
   * key: before #206 the store held only those, and every agent secret gets its row before its value. A model key row
   * whose value is gone was deleted (API keys page). An agent row without a value stays: it shows « no value ».
   */
  sync(): void {
    if (!this.store || this.locked()) return;
    const names = this.stored();
    const rows = new Map((this.db.prepare('SELECT name, kind FROM secrets').all() as { name: string; kind: SecretKind }[]).map((r) => [r.name, r.kind]));
    const now = new Date().toISOString();
    let changed = false;
    this.db.transaction(() => {
      for (const n of names) {
        if (isTokenEntry(n) || rows.has(n)) continue;
        this.db
          .prepare("INSERT INTO secrets (name, kind, created_by, created_at, updated_at, updated_by) VALUES (?, 'model_key', 'user', ?, ?, 'user')")
          .run(n, now, now);
        changed = true;
      }
      for (const [n, kind] of rows)
        if (kind === 'model_key' && !names.has(n)) {
          this.db.prepare('DELETE FROM secrets WHERE name = ?').run(n);
          changed = true;
        }
    })();
    if (changed) this.bus.emit({ type: 'secrets.updated' });
  }

  /** `project` (#215): `global` = the global ones only; a project id = that project's only; omitted = every secret. */
  list(project?: string): SecretList {
    this.sync();
    const names = this.stored();
    const rows = this.db.prepare('SELECT * FROM secrets ORDER BY kind DESC, name').all() as SecretRow[];
    const pid = project === undefined || project === 'global' ? project : this.projectOf(project);
    const inFilter = (r: SecretRow) => pid === undefined || (pid === 'global' ? r.project === null : r.project === pid);
    return {
      store: this.store?.label ?? null,
      status: this.status(),
      names: [...names].filter((n) => !isTokenEntry(n)),
      secrets: rows.filter((r) => !isTokenEntry(r.name) && inFilter(r)).map((r) => toInfo(r, names.has(r.name))),
    };
  }

  /** A project's id from its id or name. */
  private projectOf(p: string): string {
    const r = this.db.prepare('SELECT id FROM projects WHERE id = ? OR name = ? COLLATE NOCASE').get(p, p) as { id: string } | undefined;
    if (!r) throw new NotFoundError(`project ${p} not found`);
    return r.id;
  }

  get(name: string): SecretInfo {
    const r = this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as SecretRow | undefined;
    if (!r || isTokenEntry(name)) throw new NotFoundError(`no secret ${name}`);
    return toInfo(r, this.stored().has(name));
  }

  private needStore(): SecretStore {
    if (!this.store) throw new ConflictError('this engine has no secret store: its keys come from its environment');
    if (this.locked())
      throw new ConflictError(this.status().exists ? LOCKED : 'secret store locked: no secrets password yet, set one in Settings → Secrets (or ATLAS_SECRETS_PASSWORD)');
    return this.store;
  }

  /** The agents of a grant; a project's secret can be granted only to that project's members (#215). */
  private checkGrant(kind: SecretKind, grant: SecretGrant, agents: string[], project: string | null = null): string[] {
    if (kind === 'model_key' && grant !== 'none') throw new ConflictError('model keys are never given to agents');
    if (kind === 'model_key' && project) throw new ConflictError('model keys are global: they belong to no project');
    if (grant !== 'agents') return [];
    const list = [...new Set(agents)];
    if (!list.length) throw new ConflictError('pick at least one agent, or grant it to no agent');
    for (const a of list) {
      if (!this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(a)) throw new ConflictError(`agent ${a} does not exist`);
      if (project && !this.db.prepare('SELECT 1 FROM project_members WHERE project_id = ? AND agent_id = ?').get(project, a))
        throw new ConflictError(`@${a} is not a member of project ${project}: a project's secret goes only to its members`);
    }
    return list;
  }

  /** A new agent secret: its row first, then its value (a crash in between leaves a row with « no value »). */
  create(input: CreateSecret, who: SecretActor): SecretInfo {
    const c = CreateSecret.parse(input);
    const store = this.needStore();
    if (isTokenEntry(c.name)) throw new ConflictError(`${c.name} belongs to a sign-in (ChatGPT or Claude plan)`);
    if (this.modelKeyNames().includes(c.name) || ENGINE_ONLY.includes(c.name)) throw new ConflictError(`${c.name} is a model key's name: pick another name`);
    if (RESERVED.includes(c.name)) throw new ConflictError(`${c.name} is a variable every shell needs: pick another name`);
    if (this.db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(c.name) || store.names().includes(c.name))
      throw new ConflictError(`a secret named ${c.name} already exists`);
    const project = c.project === null ? null : this.projectOf(c.project);
    const agents = this.checkGrant('agent', c.grant, c.agents, project);
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO secrets (name, description, kind, grant_to, agents, project, created_by, created_card, created_at, updated_at, updated_by) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(c.name, c.description, c.grant, JSON.stringify(agents), project, who.by, who.card ?? null, now, now, who.by);
    try {
      store.set(c.name, c.value);
    } catch (e) {
      this.db.prepare('DELETE FROM secrets WHERE name = ?').run(c.name);
      throw e;
    }
    this.bus.emit({ type: 'secrets.updated' });
    return this.get(c.name);
  }

  /** Description, grant and project (null = global); the name never changes. */
  update(name: string, input: UpdateSecret, who: SecretActor): SecretInfo {
    const p = UpdateSecret.parse(input);
    const cur = this.get(name);
    const grant = p.grant ?? cur.grant;
    const project = p.project === undefined ? cur.project : p.project === null ? null : this.projectOf(p.project);
    const agents = this.checkGrant(cur.kind, grant, p.agents ?? cur.agents, project);
    this.db
      .prepare('UPDATE secrets SET description = ?, grant_to = ?, agents = ?, project = ?, updated_at = ?, updated_by = ? WHERE name = ?')
      .run(p.description ?? cur.description, grant, JSON.stringify(agents), project, new Date().toISOString(), who.by, name);
    this.bus.emit({ type: 'secrets.updated' });
    this.resume();
    return this.get(name);
  }

  /**
   * A new value (rotation, or the value of a row that has none). A name without a row is a model key (the API keys
   * page, PUT /api/secrets/:name): its row goes first, like create.
   */
  setValue(name: string, value: string, who: SecretActor): void {
    const store = this.needStore();
    if (!SECRET_NAME.test(name)) throw new ConflictError(`${name} is not a valid variable name (A-Z, 0-9, _)`);
    if (isTokenEntry(name)) throw new ConflictError(`${name} belongs to a sign-in (ChatGPT or Claude plan)`);
    const v = value.trim();
    if (!v) throw new ConflictError('the value is empty');
    const now = new Date().toISOString();
    const known = this.db.prepare('SELECT 1 FROM secrets WHERE name = ?').get(name);
    if (!known)
      this.db
        .prepare("INSERT INTO secrets (name, kind, created_by, created_card, created_at, updated_at, updated_by) VALUES (?, 'model_key', ?, ?, ?, ?, ?)")
        .run(name, who.by, who.card ?? null, now, now, who.by);
    store.set(name, v);
    this.db.prepare('UPDATE secrets SET updated_at = ?, updated_by = ? WHERE name = ?').run(now, who.by, name);
    this.bus.emit({ type: 'secrets.updated' });
    this.resume();
  }

  /** The value first, then the row: a crash in between leaves a row with « no value », never a value without a row. */
  delete(name: string): void {
    const store = this.needStore();
    if (isTokenEntry(name)) throw new ConflictError('sign out instead (Settings → Subscriptions)');
    if (store.names().includes(name)) store.delete(name);
    this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
    this.bus.emit({ type: 'secrets.updated' });
  }

  /** Names no agent may take: plan sign-ins, model keys, engine passwords, shell basics. */
  private refuseName(name: string): void {
    if (!SECRET_NAME.test(name)) throw new ConflictError(`${name} is not a valid variable name: A-Z, 0-9 and _, starting with a letter`);
    if (isTokenEntry(name)) throw new ConflictError(`${name} belongs to a sign-in (ChatGPT or Claude plan)`);
    if (this.modelKeyNames().includes(name) || ENGINE_ONLY.includes(name)) throw new ConflictError(`${name} is a model key: agents can't set or use it`);
    if (RESERVED.includes(name)) throw new ConflictError(`${name} is a variable every shell needs: pick another name`);
  }

  private row(name: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM secrets WHERE name = ?').get(name) as SecretRow | undefined;
  }

  /**
   * A row a run in `projectId` may know of: global or that project's. Another project's row is refused without naming
   * its project or owner (names are unique across projects, so the name itself can't be reused).
   */
  private rowIn(name: string, projectId: string): SecretRow | undefined {
    const r = this.row(name);
    if (r && r.project !== null && r.project !== projectId) throw new ConflictError(`the name ${name} is taken: pick another name`);
    return r;
  }

  /** Why `agentId` may not change this row, or null. */
  private notOwner(r: SecretRow, agentId: string): string | null {
    if (r.kind === 'model_key') return `${r.name} is a model key: agents can't set or delete it`;
    if (r.created_by === agentId) return null;
    return `${r.name} belongs to ${r.created_by === 'user' ? 'the user' : `@${r.created_by}`}: you can only change secrets you created (pick another name, or ask the user)`;
  }

  /**
   * secret_set (#207): an agent stores a value. New: in the run's project (#215), granted to that agent only, created
   * by it, from its task. An existing name only if the agent created it (rotation). The row goes before the value,
   * like create().
   */
  agentSet(agentId: string, projectId: string, cardId: string | null, name: string, value: string, description?: string): { created: boolean } {
    const store = this.needStore();
    this.refuseName(name);
    const v = value.trim();
    if (!v) throw new ConflictError('the value is empty: nothing stored');
    const r = this.rowIn(name, projectId);
    if (!r && store.names().includes(name)) throw new ConflictError(`${name} is a model key: agents can't set or use it`);
    const now = new Date().toISOString();
    if (r) {
      const why = this.notOwner(r, agentId);
      if (why) throw new ConflictError(why);
      store.set(name, v);
      this.db
        .prepare('UPDATE secrets SET description = ?, updated_at = ?, updated_by = ? WHERE name = ?')
        .run(description?.trim() || r.description, now, agentId, name);
    } else {
      this.db
        .prepare(
          "INSERT INTO secrets (name, description, kind, grant_to, agents, project, created_by, created_card, created_at, updated_at, updated_by) VALUES (?, ?, 'agent', 'agents', ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(name, description?.trim() ?? '', JSON.stringify([agentId]), projectId, agentId, cardId, now, now, agentId);
      try {
        store.set(name, v);
      } catch (e) {
        this.db.prepare('DELETE FROM secrets WHERE name = ?').run(name);
        throw e;
      }
    }
    this.bus.emit({ type: 'secrets.updated' });
    this.resume();
    return { created: !r };
  }

  /** secret_delete (#207): only a secret the agent created, global or in the run's project. */
  agentDelete(agentId: string, projectId: string, name: string): void {
    const r = this.row(name);
    if (!r || isTokenEntry(name) || (r.project !== null && r.project !== projectId)) throw new NotFoundError(`no secret ${name}`);
    const why = this.notOwner(r, agentId);
    if (why) throw new ConflictError(why);
    this.delete(name);
  }

  /**
   * « Needs secret X » (task_block with `secret`, #207): a row without a value, granted to the agent, that the user
   * fills in Settings → Secrets; the task goes back to work by itself then (resume()). An existing row the agent can't
   * use yet (no value, or not granted) just gets the task as waiting. Idempotent: a run that blocks again after a crash
   * finds its row.
   */
  need(agentId: string, projectId: string, cardId: string, name: string, description?: string): void {
    this.needStore();
    this.refuseName(name);
    const r = this.rowIn(name, projectId);
    if (!r && this.stored().has(name)) throw new ConflictError(`${name} is a model key: agents can't set or use it`);
    const now = new Date().toISOString();
    if (!r) {
      this.db
        .prepare(
          "INSERT INTO secrets (name, description, kind, grant_to, agents, project, created_by, created_card, created_at, updated_at, updated_by, waiting_card) VALUES (?, ?, 'agent', 'agents', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(name, description?.trim() ?? '', JSON.stringify([agentId]), projectId, agentId, cardId, now, now, agentId, cardId);
    } else {
      if (r.kind === 'model_key') throw new ConflictError(`${name} is a model key: agents can't set or use it`);
      if (this.stored().has(name) && grantedTo(toInfo(r, true), agentId, projectId))
        throw new ConflictError(`${name} already has a value and is granted to you: use $${name} in your commands`);
      this.db
        .prepare('UPDATE secrets SET waiting_card = ?, description = ? WHERE name = ?')
        .run(cardId, r.description || description?.trim() || '', name);
    }
    this.bus.emit({ type: 'secrets.updated' });
  }

  /**
   * Tasks waiting on a secret that is now there (value stored, granted to the task's agent) go back to work: a note in
   * the thread, status ready, the wait cleared, in one transaction. Also run at engine start: a crash between the
   * value's write and this leaves the task blocked until then, never lost. A task no longer blocked just drops the wait.
   */
  resume(): void {
    const kanban = this.kanban;
    if (!kanban || !this.store || this.locked()) return; // a locked store: resumed at the unlock (changed())
    const rows = this.db.prepare('SELECT * FROM secrets WHERE waiting_card IS NOT NULL').all() as SecretRow[];
    if (!rows.length) return;
    let names: Set<string>;
    try {
      names = this.stored();
    } catch (e) {
      console.error('secrets: the store could not be read to resume waiting tasks', e);
      return;
    }
    for (const r of rows) {
      const card = (() => {
        try {
          return kanban.get(r.waiting_card!);
        } catch {
          return null;
        }
      })();
      const clear = () => this.db.prepare('UPDATE secrets SET waiting_card = NULL WHERE name = ? AND waiting_card = ?').run(r.name, r.waiting_card);
      if (!card || card.status !== 'blocked') {
        clear();
        continue;
      }
      if (!names.has(r.name) || !card.assignee || !grantedTo(toInfo(r, true), card.assignee, card.projectId)) continue;
      this.db.transaction(() => {
        kanban.appendMessage(card.id, 'user', 'system', [
          { type: 'text', text: `The secret ${r.name} now has a value: use $${r.name} in your shell commands (never print it). Continue the task.` },
        ]);
        kanban.update(card.id, { status: 'ready' }, 'user');
        clear();
      })();
    }
    this.bus.emit({ type: 'secrets.updated' });
  }

  /** The agent secrets an agent may use in a project: global + that project's (names and descriptions, for its instructions). */
  granted(agentId: string, projectId: string): SecretInfo[] {
    return this.list().secrets.filter((s) => grantedTo(s, agentId, projectId));
  }

  /**
   * The environment of one command of `agentId` in a run of `projectId`: the base (login PATH, git author) without any
   * model key or engine password, plus the agent's granted secrets there (global + that project's, #215), read now (a
   * rotation applies to the next command). Throws, so the command does not run, when the store can't be read or the
   * command uses a secret it can see but not have. Another project's secrets are out of sight: never in the env (even
   * when the engine's own env has one by that name), never named in an error.
   */
  envFor(agentId: string, projectId: string, base: NodeJS.ProcessEnv, command: string): NodeJS.ProcessEnv {
    const env = { ...base };
    for (const n of [...this.modelKeyNames(), ...ENGINE_ONLY]) delete env[n];
    const rows = this.db.prepare('SELECT * FROM secrets').all() as SecretRow[];
    for (const r of rows) if (r.kind === 'model_key') delete env[r.name];
    for (const n of Object.keys(env)) if (isTokenEntry(n)) delete env[n];
    const mine = rows.filter((r) => r.kind === 'agent' && grantedTo(toInfo(r, false), agentId, projectId));
    // Not granted here: never in the env, whatever the base holds under that name.
    for (const r of rows) if (r.kind === 'agent' && !mine.includes(r)) delete env[r.name];
    for (const r of rows)
      if (r.kind === 'agent' && !mine.includes(r) && (r.project === null || r.project === projectId) && mentions(command, r.name))
        throw new Error(`secret ${r.name} is not granted to ${agentId}: ask the user to grant it in Settings → Secrets`);
    if (!mine.length) return env;
    if (!this.store) throw new Error('secrets are not available: this engine has no secret store');
    if (this.locked()) {
      // Locked: a command that uses a granted secret stops; one that uses none runs, without secrets.
      const needed = mine.filter((r) => mentions(command, r.name)).map((r) => r.name);
      if (needed.length) throw new Error(`${LOCKED} (the command uses ${needed.map((n) => '$' + n).join(', ')})`);
      return env;
    }
    let names: Set<string>;
    try {
      names = this.stored();
    } catch (e) {
      throw new Error(`the secret store (${this.store.label}) is unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const used: string[] = [];
    for (const r of mine) {
      if (!names.has(r.name)) {
        if (mentions(command, r.name)) throw new Error(`secret ${r.name} has no value: add it in Settings → Secrets`);
        continue;
      }
      let v: string | undefined;
      try {
        v = this.store.get(r.name);
      } catch (e) {
        throw new Error(`the secret store (${this.store.label}) could not read ${r.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (v === undefined) {
        if (mentions(command, r.name)) throw new Error(`secret ${r.name} has no value: add it in Settings → Secrets`);
        continue;
      }
      env[r.name] = v;
      if (mentions(command, r.name)) used.push(r.name);
    }
    if (used.length) {
      const now = new Date().toISOString();
      const mark = this.db.prepare('UPDATE secrets SET last_used_at = ?, last_used_by = ? WHERE name = ?');
      this.db.transaction(() => used.forEach((n) => mark.run(now, agentId, n)))();
      this.bus.emit({ type: 'secrets.updated' });
    }
    return env;
  }

  /**
   * Every secret value Atlas knows, longest first: all stored secrets (agent secrets, model keys, the tokens inside plan
   * sign-ins) and the model keys and passwords of the engine's environment (server mode). Read at each call: a rotated
   * value is hidden from the next output on. Throws when the store can't be read (the caller withholds the output).
   */
  private values(): { name: string; value: string }[] {
    const out = new Map<string, string>();
    const add = (name: string, value: unknown) => {
      if (typeof value === 'string' && value.length >= REDACT_MIN && !out.has(value)) out.set(value, name);
    };
    for (const n of this.locked() ? [] : (this.store?.names() ?? [])) {
      const v = this.store!.get(n);
      if (v === undefined) continue;
      if (!isTokenEntry(n)) {
        add(n, v);
        continue;
      }
      // A plan sign-in: a JSON object; its tokens are the secret parts.
      try {
        const o = JSON.parse(v) as Record<string, unknown>;
        for (const [k, x] of Object.entries(o)) if (/token|secret|key/i.test(k)) add(n, x);
      } catch {
        add(n, v);
      }
    }
    for (const n of [...this.modelKeyNames(), ...ENGINE_ONLY]) add(n, this.env[n]);
    return [...out].map(([value, name]) => ({ name, value })).sort((a, b) => b.value.length - a.value.length);
  }

  /** Replace every secret value in `text` by [secret NAME]; `hidden` = how many were replaced. */
  redact(text: string): { text: string; hidden: number } {
    let hidden = 0;
    for (const { name, value } of this.values()) {
      if (!text.includes(value)) continue;
      const parts = text.split(value);
      hidden += parts.length - 1;
      text = parts.join(`[secret ${name}]`);
    }
    return { text, hidden };
  }
}

/** An agent secret this agent may use in a run of `projectId`: global or that project's, and granted to it. */
const grantedTo = (s: Pick<SecretInfo, 'kind' | 'grant' | 'agents' | 'project'>, agentId: string, projectId: string) =>
  s.kind === 'agent' && (s.project === null || s.project === projectId) && (s.grant === 'all' || (s.grant === 'agents' && s.agents.includes(agentId)));

const toInfo = (r: SecretRow, hasValue: boolean): SecretInfo => ({
  name: r.name,
  description: r.description,
  kind: r.kind,
  grant: r.grant_to,
  agents: JSON.parse(r.agents) as string[],
  project: r.project,
  hasValue,
  createdBy: r.created_by,
  createdCard: r.created_card,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
  lastUsedAt: r.last_used_at,
  lastUsedBy: r.last_used_by,
  waitingCard: r.waiting_card,
});
