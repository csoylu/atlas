import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VOICE_NAMES, type MicAccess, type ServerEvent, type VoiceStatus } from '@atlas/shared';
import { VOICES, defaultModelsDir, missingModels, type ModelId, type ModelSpec } from '@atlas/voice';
import { openDb } from './store/db.ts';
import { Bus } from './events.ts';
import { Voice, wav, type VoiceHost } from './voice.ts';
import { startEngine, type Engine } from './index.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const files: Record<string, Buffer> = { '/vad': Buffer.from('vad weights'), '/stt': Buffer.from('stt weights'), '/tts': Buffer.from('tts weights') };
let broken = true; // /tts answers 404 until fixed
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (!body || (broken && req.url === '/tts')) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-length': body.length }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const specs = (): Record<ModelId, ModelSpec> => {
  const spec = (id: ModelId): ModelSpec => ({ id, url: `${base}/${id}`, sha256: sha(files['/' + id]!), kind: 'file', fileName: 'w', files: ['w'], bytes: files['/' + id]!.length });
  return { vad: spec('vad'), stt: spec('stt'), tts: spec('tts') };
};

class FakeHost implements VoiceHost {
  mic: MicAccess = 'not-determined';
  asked = 0;
  constructor(readonly modelsDir: string, private answer: boolean) {}
  micAccess = () => this.mic;
  requestMicAccess = async () => {
    this.asked++;
    this.mic = this.answer ? 'granted' : 'denied';
    return this.answer;
  };
}

const settle = async (v: Voice) => {
  for (let i = 0; i < 200 && v.status().download; i++) await new Promise((r) => setTimeout(r, 10));
};

describe('voice settings', () => {
  it('is off by default, persists settings in SQLite and validates them', async () => {
    const db = openDb(':memory:');
    const v = new Voice(db, new Bus(), new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true), specs());
    expect(v.status()).toMatchObject({ enabled: false, voice: 'voice-9', sensitivity: 0.5, download: null, ready: false, error: null });
    await v.update({ voice: 'voice-3', sensitivity: 0.8 });
    // a fresh Voice on the same database reads them back (restart)
    expect(new Voice(db, new Bus(), new FakeHost('/nowhere', true), specs()).status()).toMatchObject({ voice: 'voice-3', sensitivity: 0.8 });
    await expect(v.update({ voice: 'nobody' })).rejects.toThrow();
    await expect(v.update({ sensitivity: 2 })).rejects.toThrow();
  });

  it('push-to-talk and the wake word: on by default (hold ⌥ on a Mac, ⌥Space elsewhere), persisted, shortcut validated, registration errors shown (#57, #75)', async () => {
    const db = openDb(':memory:');
    const bus = new Bus();
    const events: ServerEvent[] = [];
    bus.on((e) => events.push(e));
    const v = new Voice(db, bus, new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true), specs(), Date.now, 'darwin');
    expect(v.status()).toMatchObject({ wakeWord: true, ptt: { enabled: true, shortcut: 'Option', error: null, permission: false } });
    expect(new Voice(db, new Bus(), new FakeHost('/nowhere', true), specs(), Date.now, 'win32').status().ptt.shortcut).toBe('Alt+Space');
    expect(new Voice(db, new Bus(), new FakeHost('/nowhere', true), specs(), Date.now, 'linux').status().ptt.shortcut).toBe('Alt+Space');
    // a shortcut Master picked stays, on every platform; the default moves (nothing stored until Master picks one)
    await v.update({ pttShortcut: 'Alt+Space' });
    expect(new Voice(db, new Bus(), new FakeHost('/nowhere', true), specs(), Date.now, 'darwin').status().ptt.shortcut).toBe('Alt+Space');
    await v.update({ pttShortcut: 'Option' });
    expect(v.status().ptt.shortcut).toBe('Option');
    await expect(v.update({ pttShortcut: 'Option+K' })).rejects.toThrow(/modifier/);
    v.setPttError('Atlas may not watch the keyboard', true);
    expect(v.status().ptt).toMatchObject({ error: 'Atlas may not watch the keyboard', permission: true });
    v.setPttError(null, true);
    expect(v.status().ptt).toMatchObject({ error: null, permission: false });
    await v.update({ wakeWord: false, ptt: true, pttShortcut: 'Command+Shift+K' });
    expect(new Voice(db, new Bus(), new FakeHost('/nowhere', true), specs()).status()).toMatchObject({ wakeWord: false, ptt: { enabled: true, shortcut: 'Command+Shift+K' } });
    await expect(v.update({ pttShortcut: 'K' })).rejects.toThrow(/modifier/);
    await expect(v.update({ pttShortcut: 'Hyper+K' })).rejects.toThrow(/modifier/);
    await expect(v.update({ pttShortcut: 'Alt+Escape' })).rejects.toThrow(/key/);
    v.setPttError('⌘⇧K is taken by another app');
    expect(v.status().ptt.error).toBe('⌘⇧K is taken by another app');
    expect(events.at(-1)).toMatchObject({ type: 'voice.updated', status: { ptt: { error: '⌘⇧K is taken by another app' } } });
    await v.update({ pttShortcut: 'Alt+Space' }); // a new shortcut: registered again by the desktop app
    expect(v.status().ptt.error).toBeNull();
  });

  it('turning on downloads the models with progress, asks for the microphone, then is ready', async () => {
    broken = false;
    const bus = new Bus();
    const events: VoiceStatus[] = [];
    bus.on((e: ServerEvent) => e.type === 'voice.updated' && events.push(e.status));
    const host = new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true);
    const v = new Voice(openDb(':memory:'), bus, host, specs());
    await v.update({ enabled: true });
    await settle(v);
    expect(host.asked).toBe(1);
    expect(events.some((s) => s.download && s.download.total === 33)).toBe(true);
    expect(v.status()).toMatchObject({ enabled: true, mic: 'granted', ready: true, error: null, download: null });
    expect(v.status().models.every((m) => m.installed)).toBe(true);
    expect(readdirSync(host.modelsDir).sort()).toEqual(['stt', 'tts', 'vad']);
  });

  it('pauses listening (until resumed, or until a time that survives a restart) and resumes', async () => {
    broken = false;
    const db = openDb(':memory:');
    const bus = new Bus();
    const events: VoiceStatus[] = [];
    bus.on((e: ServerEvent) => e.type === 'voice.updated' && events.push(e.status));
    const host = new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true);
    let now = Date.parse('2026-11-14T10:00:00Z');
    const v = new Voice(db, bus, host, specs(), () => now);
    await expect(v.update({ pause: { until: null } })).rejects.toThrow(/voice mode is off/);
    await v.update({ enabled: true });
    await settle(v);
    expect(v.status()).toMatchObject({ ready: true, paused: null });
    await v.update({ pause: { until: null } });
    expect(v.status()).toMatchObject({ enabled: true, ready: false, paused: { until: null } });
    expect(events.at(-1)?.paused).toEqual({ until: null });
    await v.update({ pause: null });
    expect(v.status()).toMatchObject({ ready: true, paused: null });
    await expect(v.update({ pause: { until: '2026-11-14T09:00:00Z' } })).rejects.toThrow(/future/);
    await expect(v.update({ pause: { until: 'tomorrow' } })).rejects.toThrow();
    await v.update({ pause: { until: '2026-11-14T11:00:00Z' } });
    expect(v.status().paused).toEqual({ until: '2026-11-14T11:00:00.000Z' });
    // a restart keeps the pause (SQLite)
    const again = new Voice(db, new Bus(), host, specs(), () => now);
    expect(again.status()).toMatchObject({ ready: false, paused: { until: '2026-11-14T11:00:00.000Z' } });
    now = Date.parse('2026-11-14T11:00:01Z');
    expect(again.status()).toMatchObject({ ready: true, paused: null });
    v.stop();
    // turning voice off ends a pause
    await v.update({ pause: { until: null } });
    await v.update({ enabled: false });
    await v.update({ enabled: true });
    expect(v.status().paused).toBeNull();
    v.stop();
  });

  it('a timed pause ends by itself with voice.updated', async () => {
    broken = false;
    const bus = new Bus();
    const events: VoiceStatus[] = [];
    bus.on((e: ServerEvent) => e.type === 'voice.updated' && events.push(e.status));
    const v = new Voice(openDb(':memory:'), bus, new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true), specs());
    await v.update({ enabled: true });
    await settle(v);
    await v.update({ pause: { until: new Date(Date.now() + 60).toISOString() } });
    expect(v.status().ready).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(v.status()).toMatchObject({ ready: true, paused: null });
    expect(events.at(-1)).toMatchObject({ ready: true, paused: null });
    v.stop();
  });

  it('shows a failed download and a denied microphone, and retries', async () => {
    broken = true;
    const host = new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), false);
    const v = new Voice(openDb(':memory:'), new Bus(), host, specs());
    await v.update({ enabled: true });
    await settle(v);
    expect(v.status()).toMatchObject({ enabled: true, mic: 'denied', ready: false });
    expect(v.status().error).toMatch(/Voice model download failed: .*HTTP 404/);
    expect(v.status().models.map((m) => m.installed)).toEqual([true, true, false]);
    broken = false;
    await v.ensureModels();
    expect(v.status().error).toBeNull();
    expect(v.status().models.every((m) => m.installed)).toBe(true);
  });

  it('resumes the download on engine start when voice was left on', async () => {
    broken = false;
    const db = openDb(':memory:');
    db.prepare("INSERT INTO settings (key, value) VALUES ('voice_enabled', '1')").run();
    const v = new Voice(db, new Bus(), new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true), specs());
    v.start();
    expect(v.status().download).not.toBeNull();
    await settle(v);
    expect(v.status().models.every((m) => m.installed)).toBe(true);
  });

  it('lists the same voices as the voice engine', () => {
    expect([...VOICE_NAMES].sort()).toEqual(Object.keys(VOICES).sort());
  });

  it('encodes 16-bit WAV', () => {
    const b = wav(new Float32Array([0, 1, -1]), 24_000);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.readUInt32LE(24)).toBe(24_000);
    expect(b.length).toBe(44 + 6);
    expect(b.readInt16LE(46)).toBe(32767);
  });
});

describe('voice api', () => {
  let engine: Engine | undefined;
  afterEach(async () => {
    await engine?.stop();
    engine = undefined;
  });

  it('is hidden without the desktop host (server mode, dev)', async () => {
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0 });
    expect(((await (await fetch(engine.url + '/api/about')).json()) as { voice: boolean }).voice).toBe(false);
    expect((await fetch(engine.url + '/api/voice')).status).toBe(404);
  });

  it('serves status, settings and refuses Test voice before the download', async () => {
    const host = new FakeHost(mkdtempSync(join(tmpdir(), 'vm-')), true);
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, voice: host });
    expect(((await (await fetch(engine.url + '/api/about')).json()) as { voice: boolean }).voice).toBe(true);
    expect(((await (await fetch(engine.url + '/api/voice')).json()) as VoiceStatus).enabled).toBe(false);
    const patched = await fetch(engine.url + '/api/voice', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: 'voice-1' }) });
    expect(((await patched.json()) as VoiceStatus).voice).toBe('voice-1');
    const test = await fetch(engine.url + '/api/voice/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(test.status).toBe(409);
    expect(((await test.json()) as { error: string }).error).toMatch(/not downloaded/);
  });

  // The real Supertonic model (~150 MB) runs where it is installed, like the @atlas/voice model tests.
  it.skipIf(missingModels(defaultModelsDir()).includes('tts'))('Test voice returns a spoken WAV', async () => {
    const host = new FakeHost(defaultModelsDir(), true);
    engine = await startEngine({ dbFile: ':memory:', dataDir: mkdtempSync(join(tmpdir(), 'atlas-')), port: 0, voice: host });
    const res = await fetch(engine.url + '/api/voice/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: 'voice-9' }) });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const b = Buffer.from(await res.arrayBuffer());
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.length).toBeGreaterThan(44 + 44_100); // more than half a second of audio
  }, 60_000);
});
