import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { UpdateLocal, PullName, type LocalModel, type LocalPull, type LocalStatus } from '@atlas/shared';
import type { Bus } from './events.ts';
import type { Db } from './store/db.ts';
import { ConflictError, InvalidError, NotFoundError } from './kanban.ts';

/**
 * The local model server (design §5): the engine finds, installs, starts, watches and stops Ollama on its own machine,
 * downloads models from the Ollama library and loads/unloads them. The UI only asks.
 *
 * Ownership: if Ollama already answers (the Ollama app, `brew services`), the engine uses it and leaves it alone
 * ("external"). If nothing answers, the engine starts `ollama serve` itself ("atlas"), restarts it when it crashes and
 * stops it when the engine stops. "Stop" on an external server stops the brew service, after which Atlas owns it.
 */

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_CONTEXT = 32_768;
/** GUI apps (Electron) don't get the shell PATH: look where installers put the binary. */
const CANDIDATES = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
  '/usr/bin/ollama',
];
const BREW = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
/** At most this many automatic restarts per window, then the error stays until someone acts. */
const MAX_RESTARTS = 4;
const RESTART_WINDOW_MS = 10 * 60_000;

export interface LocalOptions {
  dataDir: string;
  /** ATLAS_OLLAMA_URL: another host/port. */
  url?: string;
  /** Tests: no binary lookup / no spawning. */
  binary?: string | null;
  fetch?: typeof fetch;
}

export class Local {
  readonly url: string;
  private child: ChildProcess | null = null;
  private log: WriteStream | null = null;
  private stopping = false;
  private restarts: number[] = [];
  private error: string | null = null;
  private installing = false;
  private version: string | null = null;
  private running = false;
  private starting: Promise<void> | null = null;
  private pulls = new Map<string, { pull: LocalPull; abort: AbortController }>();
  private poll: NodeJS.Timeout | null = null;
  private fetch: typeof fetch;
  private binaryOverride: string | null | undefined;

  constructor(
    private db: Db,
    private bus: Bus,
    private opts: LocalOptions,
  ) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/+$/, '');
    this.fetch = opts.fetch ?? fetch;
    this.binaryOverride = opts.binary;
  }

  // ── settings (settings table, keys local_*) ───────────────────────────
  private setting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  private setSetting(key: string, value: string) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  get autostart(): boolean {
    return this.setting('local_autostart') !== '0';
  }
  get contextLength(): number {
    return Number(this.setting('local_context')) || DEFAULT_CONTEXT;
  }

  binary(): string | null {
    if (this.binaryOverride !== undefined) return this.binaryOverride;
    return CANDIDATES.find((p) => existsSync(p)) ?? null;
  }
  private brew(): string | null {
    return process.platform === 'darwin' ? (BREW.find((p) => existsSync(p)) ?? null) : null;
  }

  status(): LocalStatus {
    return {
      runtime: 'ollama',
      url: this.url,
      binary: this.binary(),
      version: this.version,
      running: this.running,
      owner: this.running ? (this.child ? 'atlas' : 'external') : null,
      autostart: this.autostart,
      contextLength: this.contextLength,
      canInstall: !!this.brew(),
      installing: this.installing,
      error: this.error,
      totalMemory: totalmem(),
    };
  }
  private changed() {
    this.bus.emit({ type: 'local.updated', status: this.status() });
  }

  private async api<T>(path: string, init?: RequestInit & { timeout?: number }): Promise<T> {
    const res = await this.fetch(this.url + path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      signal: init?.signal ?? AbortSignal.timeout(init?.timeout ?? 5000),
    });
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** Is the server answering? Updates the cached state; emits on change. */
  async probe(): Promise<boolean> {
    const before = this.running;
    try {
      this.version = (await this.api<{ version: string }>('/api/version', { timeout: 1500 })).version;
      this.running = true;
    } catch {
      this.running = false;
    }
    if (before !== this.running) this.changed();
    return this.running;
  }

  async start(): Promise<void> {
    if (await this.probe()) return;
    if (this.starting) return this.starting;
    this.starting = this.spawnServer().finally(() => (this.starting = null));
    return this.starting;
  }

  private async spawnServer(): Promise<void> {
    const bin = this.binary();
    if (!bin) {
      this.error = 'Ollama is not installed.';
      this.changed();
      throw new ConflictError(this.error);
    }
    const u = new URL(this.url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new ConflictError(`Atlas only starts Ollama on this machine, not on ${u.host}`);
    const logs = join(this.opts.dataDir, 'logs');
    mkdirSync(logs, { recursive: true });
    this.log ??= createWriteStream(join(logs, 'ollama.log'), { flags: 'a' });
    this.log.write(`\n--- ${new Date().toISOString()} starting ${bin} serve\n`);
    this.stopping = false;
    const child = spawn(bin, ['serve'], {
      // One model in memory at a time unless the environment says otherwise: two big ones push a laptop into swap.
      env: { OLLAMA_MAX_LOADED_MODELS: '1', ...process.env, OLLAMA_HOST: u.host, OLLAMA_CONTEXT_LENGTH: String(this.contextLength) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let tail = '';
    const keep = (d: Buffer) => {
      this.log?.write(d);
      tail = (tail + d.toString()).slice(-2000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.running = false;
      this.log?.write(`--- exited code=${code} signal=${signal}\n`);
      if (!this.stopping) {
        const last = tail.trim().split('\n').slice(-1)[0] ?? '';
        this.error = `Ollama stopped unexpectedly (${signal ?? 'code ' + code})${last ? ': ' + last.slice(0, 200) : ''}`;
        const now = Date.now();
        this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
        if (this.restarts.length < MAX_RESTARTS) {
          this.restarts.push(now);
          setTimeout(() => void this.start().catch(() => {}), 1000 * 2 ** this.restarts.length).unref();
        }
      }
      this.changed();
    });
    // Up when it answers; give up after 20 s.
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (!this.child) break;
      if (await this.probe()) {
        this.error = null;
        this.changed();
        return;
      }
    }
    const why = this.error ?? `Ollama did not answer within 20 s${tail ? ': ' + tail.trim().split('\n').slice(-1)[0] : ''}`;
    this.error = why;
    if (this.child === child) {
      this.stopping = true;
      child.kill('SIGTERM');
    }
    this.changed();
    throw new ConflictError(why);
  }

  /** Stop the server. One Atlas started: kill it. An external brew service: stop the service. Others: say what runs it. */
  async stop(): Promise<void> {
    if (this.child) {
      const child = this.child;
      this.stopping = true;
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => (child.kill('SIGKILL'), resolve()), 5000);
        child.once('exit', () => (clearTimeout(t), resolve()));
        child.kill('SIGTERM');
      });
      this.child = null;
      this.running = false;
      this.changed();
      return;
    }
    if (!(await this.probe())) return;
    const brew = this.brew();
    if (brew && /^ollama\s+started/m.test(await run(brew, ['services', 'list']).catch(() => ''))) {
      await run(brew, ['services', 'stop', 'ollama']);
      for (let i = 0; i < 20 && (await this.probe()); i++) await new Promise((r) => setTimeout(r, 250));
      this.changed();
      return;
    }
    throw new ConflictError('Ollama was started outside Atlas (the Ollama app?). Quit it there, then Atlas can run it.');
  }

  /** Called before every call to a local model: start the server if it's down and autostart is on. */
  async ensure(): Promise<void> {
    if (this.running && (await this.probe())) return;
    if (await this.probe()) return;
    if (!this.autostart) throw new ConflictError('the local model server is stopped (start it on the Models page)');
    await this.start();
  }

  /** Points at this server? (Atlas model base URLs are <url>/v1.) */
  serves(baseUrl: string | null): boolean {
    if (!baseUrl) return false;
    const norm = (s: string) => s.replace(/\/+$/, '').replace(/\/v1$/, '').replace('localhost', '127.0.0.1');
    return norm(baseUrl) === norm(this.url);
  }

  update(patch: unknown): LocalStatus {
    const p = UpdateLocal.parse(patch);
    if (p.autostart !== undefined) this.setSetting('local_autostart', p.autostart ? '1' : '0');
    if (p.contextLength !== undefined) this.setSetting('local_context', String(p.contextLength));
    this.changed();
    return this.status();
  }

  /** Engine start: probe, autostart, and keep the state fresh while the engine runs. */
  async startWatching(): Promise<void> {
    await this.probe();
    if (!this.running && this.autostart && this.binary() && this.hasLocalModels()) await this.start().catch(() => {});
    this.poll = setInterval(() => void this.probe(), 15_000);
    this.poll.unref();
  }
  private hasLocalModels(): boolean {
    const rows = this.db.prepare('SELECT base_url FROM models').all() as { base_url: string | null }[];
    return rows.some((r) => this.serves(r.base_url));
  }

  async shutdown(): Promise<void> {
    if (this.poll) clearInterval(this.poll);
    for (const p of this.pulls.values()) p.abort.abort();
    if (this.child) await this.stop().catch(() => {});
    this.log?.end();
  }

  // ── install ───────────────────────────────────────────────────────────
  async install(): Promise<void> {
    if (this.binary()) return;
    const brew = this.brew();
    if (!brew) throw new ConflictError('Install Ollama from https://ollama.com/download, then come back here.');
    if (this.installing) return;
    this.installing = true;
    this.error = null;
    this.changed();
    run(brew, ['install', 'ollama'], 15 * 60_000)
      .then(() => {
        this.installing = false;
        if (!this.binary()) this.error = 'brew finished but no ollama binary was found';
        this.changed();
        if (this.binary()) return this.start();
      })
      .catch((e: Error) => {
        this.installing = false;
        this.error = `Installing Ollama failed: ${e.message.slice(-300)}`;
        this.changed();
      });
  }

  // ── models ────────────────────────────────────────────────────────────
  async list(): Promise<LocalModel[]> {
    if (!(await this.probe())) return [];
    type Tag = { name: string; size: number; modified_at: string; capabilities?: string[]; details?: { family?: string; parameter_size?: string; quantization_level?: string } };
    type Ps = { name: string; size_vram?: number; size?: number; context_length?: number; expires_at?: string };
    const [tags, ps] = await Promise.all([this.api<{ models: Tag[] }>('/api/tags'), this.api<{ models: Ps[] }>('/api/ps')]);
    const users = this.db.prepare('SELECT id, name, base_url FROM models').all() as { id: string; name: string; base_url: string | null }[];
    return tags.models.map((t) => {
      const p = ps.models.find((m) => m.name === t.name);
      return {
        name: t.name,
        size: t.size,
        family: t.details?.family || null,
        parameterSize: t.details?.parameter_size || null,
        quantization: t.details?.quantization_level || null,
        modifiedAt: t.modified_at,
        capabilities: t.capabilities ?? [],
        loaded: p
          ? {
              memory: p.size_vram || p.size || 0,
              contextLength: p.context_length ?? null,
              // Ollama reports "forever" as a date far in the future.
              until: p.expires_at && new Date(p.expires_at).getFullYear() < 2200 ? p.expires_at : null,
            }
          : null,
        usedBy: users.filter((u) => u.name === t.name && this.serves(u.base_url)).map((u) => u.id),
      };
    });
  }

  pulls_(): LocalPull[] {
    return [...this.pulls.values()].map((p) => p.pull);
  }

  /** Start a download; progress arrives as local.pull events. Returns at once. */
  async pull(nameIn: string): Promise<LocalPull> {
    const name = PullName.parse(nameIn);
    const existing = this.pulls.get(name);
    if (existing && !existing.pull.done) return existing.pull;
    await this.ensure();
    const pull: LocalPull = { name, status: 'starting', completed: 0, total: 0, done: false, error: null };
    const abort = new AbortController();
    this.pulls.set(name, { pull, abort });
    const emit = () => this.bus.emit({ type: 'local.pull', pull: { ...pull } });
    emit();
    void (async () => {
      let last = 0;
      // Ollama reports progress per layer (digest): sum them so the bar runs once from 0 to 100 %.
      const layers = new Map<string, { completed: number; total: number }>();
      try {
        const res = await this.fetch(this.url + '/api/pull', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: name, stream: true }),
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const decoder = new TextDecoder();
        let buf = '';
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const m = JSON.parse(line) as { status?: string; digest?: string; completed?: number; total?: number; error?: string };
            if (m.error) throw new Error(m.error);
            pull.status = m.digest ? 'downloading' : (m.status ?? pull.status);
            if (m.total) {
              layers.set(m.digest ?? '', { completed: m.completed ?? 0, total: m.total });
              pull.total = [...layers.values()].reduce((a, l) => a + l.total, 0);
              pull.completed = [...layers.values()].reduce((a, l) => a + l.completed, 0);
            }
            if (Date.now() - last > 400) {
              last = Date.now();
              emit();
            }
          }
        }
        if (pull.status !== 'success') throw new Error(`download ended at "${pull.status}"`);
      } catch (e) {
        pull.error = abort.signal.aborted ? 'cancelled' : hint(e instanceof Error ? e.message : String(e));
      }
      pull.done = true;
      emit();
      this.changed();
    })();
    return pull;
  }

  cancelPull(name: string): void {
    const p = this.pulls.get(name);
    if (!p) throw new NotFoundError(`no download of ${name}`);
    if (p.pull.done) this.pulls.delete(name);
    else p.abort.abort();
  }

  async remove(name: string): Promise<void> {
    const used = (this.db.prepare('SELECT id, base_url FROM models WHERE name = ?').all(name) as { id: string; base_url: string | null }[]).filter((u) =>
      this.serves(u.base_url),
    );
    if (used.length) throw new ConflictError(`${name} is used by Atlas model ${used.map((u) => u.id).join(', ')}: remove that first`);
    await this.ensure();
    const res = await this.fetch(this.url + '/api/delete', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) });
    if (res.status === 404) throw new NotFoundError(`${name} is not installed`);
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    this.changed();
  }

  /**
   * Load into memory and keep it there (keep_alive -1), or unload (0). Loading unloads the others first: models kept
   * forever pile up otherwise (a server Atlas didn't start ignores OLLAMA_MAX_LOADED_MODELS above).
   */
  async load(name: string, keep: boolean): Promise<void> {
    await this.ensure();
    if (keep) {
      const ps = await this.api<{ models: { name: string }[] }>('/api/ps');
      for (const m of ps.models)
        if (m.name !== name) await this.api('/api/generate', { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }), timeout: 60_000 });
    }
    await this.api('/api/generate', { method: 'POST', body: JSON.stringify({ model: name, keep_alive: keep ? -1 : 0 }), timeout: 180_000 });
    this.changed();
  }

}

function hint(msg: string): string {
  if (/pull model manifest|file does not exist|not found/i.test(msg)) return `${msg} — check the name on ollama.com/library (e.g. qwen3:8b)`;
  return msg;
}

function run(cmd: string, args: string[], timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20, env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr || err.message)) : resolve(stdout),
    );
  });
}
