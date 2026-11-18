import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, type Page } from '@playwright/test';
import WebSocket from 'ws';
import type { TestAtlas } from './engine.ts';

/**
 * Leak audit (#210): watch every place a secret value must never reach while a scenario runs, then look for the value
 * (and its base64 / hex forms) in all of them. The value may exist in the secret store only.
 *
 * Sinks: every file under the data dir (SQLite + its WAL, secrets.enc, checkpoints/snapshots, outputs, workspaces),
 * the engine's stdout/stderr (its logs), every API response (what the page fetched, plus a sweep of every GET list
 * and per-card endpoint), every WebSocket event (the page's frames, a second client, the bus), and everything the
 * scripted model was sent.
 */
export class Leaks {
  /** value → label, for the report. */
  private canaries = new Map<string, string>();
  private allowed: RegExp[] = [];
  private sinks = new Map<string, string[]>();
  private offLogs: (() => void) | null = null;
  private offBus: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private wsOpen: Promise<unknown> = Promise.resolve();

  /** A value that must stay out of every sink. */
  watch(label: string, value: string): string {
    this.canaries.set(value, label);
    return value;
  }
  /** A known leak (a limit written down in docs/qa/210-secrets-leak-audit.md, with its task): files matching are not reported. */
  allow(file: RegExp): void {
    this.allowed.push(file);
  }
  private put(sink: string, text: string) {
    const l = this.sinks.get(sink) ?? [];
    l.push(text);
    this.sinks.set(sink, l);
  }
  sink(name: string): string {
    return (this.sinks.get(name) ?? []).join('\n');
  }

  /** Start listening on this engine (call again after a restart: the port and the bus change). */
  attach(atlas: TestAtlas, page?: Page): void {
    this.detach();
    // The engine runs in this process: its console output is its log.
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    const grab = (sink: string) => (chunk: unknown, ...rest: unknown[]) => {
      this.put(sink, typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (sink === 'stdout' ? out : err)(chunk as never, ...(rest as []));
    };
    process.stdout.write = grab('stdout') as never;
    process.stderr.write = grab('stderr') as never;
    this.offLogs = () => {
      process.stdout.write = out as never;
      process.stderr.write = err as never;
    };
    this.offBus = atlas.engine.bus.on((e) => void this.put('bus events', JSON.stringify(e)));
    const ws = new WebSocket(atlas.url.replace(/^http/, 'ws') + '/api/events');
    ws.on('message', (d) => void this.put('websocket (second client)', d.toString()));
    this.ws = ws;
    this.wsOpen = new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej)));
    if (page) {
      page.on('response', async (r) => {
        if (!r.url().includes('/api/')) return;
        try {
          this.put('api responses (page)', r.url() + '\n' + (await r.text()));
        } catch {
          // a redirect, or the page closed first: no body
        }
      });
      page.on('websocket', (w) => w.on('framereceived', (f) => void this.put('websocket (page)', String(f.payload))));
    }
  }
  detach(): void {
    this.offLogs?.();
    this.offBus?.();
    this.ws?.close();
    this.offLogs = this.offBus = this.ws = null;
  }

  /** GET every list and per-card endpoint of the engine and keep the bodies. A route that errors fails the audit (it would hide a leak). */
  async sweep(atlas: TestAtlas): Promise<void> {
    const bad: string[] = [];
    const get = async (path: string, mayRefuse = false): Promise<unknown> => {
      const r = await fetch(atlas.url + '/api' + path);
      const t = await r.text();
      this.put('api responses (sweep)', `${path} ${r.status}\n${t}`);
      if (r.status >= 400 && !(mayRefuse && r.status === 400)) bad.push(`${path} ${r.status}`);
      try {
        return JSON.parse(t);
      } catch {
        return null;
      }
    };
    const list = async (path: string) => ((await get(path)) as { id: string }[] | null) ?? [];
    for (const p of ['/health', '/about', '/update', '/memories/changes', '/memory-proposals', '/models', '/secrets', '/secrets/status', '/settings', '/usage', '/notifications', '/inbox', '/accounts', '/local', '/local/models', '/chatgpt', '/claude', '/projects', '/folders', '/documents/search?q=a'])
      await get(p);
    const cards = await list('/cards');
    const chats = await list('/chats');
    for (const c of [...cards, ...chats]) {
      for (const p of ['', '/messages', '/runs', '/tool-calls', '/timeline', '/usage']) await get(`/cards/${c.id}${p}`);
      // The rewind preview (what a rewind would undo) for every message of the chat.
      const msgs = ((await get(`/cards/${c.id}/messages`)) as { seq: number }[] | null) ?? [];
      for (const m of msgs) await get(`/cards/${c.id}/rewind?seq=${m.seq}`, true); // 400 = not a message one can rewind to
    }
    for (const c of chats) await get(`/chats/${c.id}/panel`);
    for (const a of await list('/agents')) await get(`/agents/${a.id}/memory-budget`);
    for (const m of await list('/memories')) await get(`/memories/${m.id}`);
    for (const d of await list('/documents')) for (const p of ['', '/versions']) await get(`/documents/${d.id}${p}`);
    for (const w of await list('/workflows')) for (const p of ['', '/runs']) await get(`/workflows/${w.id}${p}`);
    if (bad.length) throw new Error('the audit sweep got errors, so it could not read those answers: ' + bad.join(', '));
  }

  /** Everything the scripted model was sent (system prompt, tools, history), whole requests. */
  modelRequests(atlas: TestAtlas): void {
    this.sinks.delete('model requests');
    for (const c of atlas.model.calls) this.put('model requests', JSON.stringify(c.req));
  }

  /**
   * The rewind snapshots (a git store in the data dir, objects zlib-compressed on disk, so a plain file scan can't see
   * into them): every object, decompressed, as a sink.
   */
  snapshots(atlas: TestAtlas): void {
    this.sinks.delete('checkpoint snapshots');
    const dir = join(atlas.dataDir, 'checkpoints');
    if (!existsSync(dir)) return;
    const out = execFileSync('git', ['--git-dir', dir, 'cat-file', '--batch-all-objects', '--batch'], { maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    this.put('checkpoint snapshots', out.toString('latin1'));
  }

  /**
   * Events reach the clients in order: emit a marker and wait until each client has it, then everything emitted before it
   * has been received too (no sleep).
   */
  private async flushEvents(atlas: TestAtlas): Promise<void> {
    await this.wsOpen; // an event emitted before the second client is connected would never reach it
    const mark = `flush-${++this.marks}`;
    atlas.engine.bus.emit({ type: 'secrets.updated', mark } as never); // the UI ignores the extra field
    const seen = (sink: string) => this.sink(sink).includes(mark);
    const sinks = ['websocket (second client)', ...(this.sinks.has('websocket (page)') ? ['websocket (page)'] : [])];
    await expect.poll(() => sinks.every(seen), { timeout: 5000, message: 'the events reach the clients' }).toBe(true);
  }
  private marks = 0;

  /** Where each watched value shows up (plaintext, base64, hex), as « sink: label (form) ». Empty = clean. */
  async findings(atlas: TestAtlas, o: { sweep?: boolean } = {}): Promise<string[]> {
    await this.flushEvents(atlas);
    if (o.sweep !== false) await this.sweep(atlas);
    this.modelRequests(atlas);
    this.snapshots(atlas);
    const found: string[] = [];
    const forms = (v: string) => [
      ['plain', Buffer.from(v)],
      ['base64', Buffer.from(Buffer.from(v).toString('base64'))],
      ['hex', Buffer.from(Buffer.from(v).toString('hex'))],
    ] as const;
    for (const [value, label] of this.canaries)
      for (const [form, needle] of forms(value)) {
        for (const [sink, parts] of this.sinks) if (Buffer.from(parts.join('\n')).includes(needle)) found.push(`${sink}: ${label} (${form})`);
        for (const f of files(atlas.dataDir)) if (!this.allowed.some((re) => re.test(f.rel)) && f.data.includes(needle)) found.push(`file ${f.rel}: ${label} (${form})`);
      }
    return found;
  }
}

/** Every file under a folder (the whole data dir: SQLite, WAL and SHM, secrets.enc, checkpoints, outputs, workspaces). */
export function files(dir: string): { rel: string; data: Buffer }[] {
  const out: { rel: string; data: Buffer }[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue; // vanished while walking (a temp file)
      }
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) out.push({ rel: relative(dir, p), data: readFileSync(p) });
    }
  };
  walk(dir);
  return out;
}
