// Push-to-talk (card #57; hold ⌥, card #75) and the wake word switch through the desktop voice loop (DesktopVoice), with a real engine
// answered by a fake provider, the real voice models, a fake orb and fake global shortcuts. Skipped without the models.
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateVoice } from '@atlas/shared';
import { startEngine, type Engine } from '@atlas/engine';
import { VoiceModels, defaultModelsDir, missingModels, type LoopState } from '@atlas/voice';
import { FakeProvider } from '../../../packages/engine/src/providers/fake.ts';
import { DesktopVoice, type ShortcutPort, type VoiceOrb } from './voice.ts';
import type { HoldEvent, HoldKeyPort } from './optionkey.ts';

const FIXTURES = join(import.meta.dirname, '../../../packages/voice/test/fixtures');
const wav = (name: string) => sherpa.readWave(join(FIXTURES, `${name}.wav`), false).samples;
const modelsDir = defaultModelsDir();
const haveModels = missingModels(modelsDir).length === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (t: string) => [{ type: 'text' as const, text: t }];

async function until(what: string, cond: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The orb as the loop drives it: records states, microphone open/close and what was said; speak() lasts `ms`. */
class FakeOrb implements VoiceOrb {
  states: LoopState[] = [];
  mics: boolean[] = [];
  spoken: string[] = [];
  errors: string[] = [];
  hushes = 0;
  private playing = new Set<{ done: (b: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(public ms = 50) {}
  setState(s: LoopState) {
    this.states.push(s);
  }
  transcript() {}
  speak(t: string) {
    return new Promise<boolean>((done) => {
      const p = { done, timer: setTimeout(() => (this.playing.delete(p), this.spoken.push(t), done(true)), this.ms) };
      this.playing.add(p);
    });
  }
  hush() {
    this.hushes++;
    for (const p of this.playing) (clearTimeout(p.timer), p.done(false));
    this.playing.clear();
  }
  error(m: string) {
    this.errors.push(m);
  }
  dismiss() {}
  mic(on: boolean) {
    this.mics.push(on);
  }
  get state() {
    return this.states.at(-1) ?? 'idle';
  }
  get micOpen() {
    return this.mics.at(-1) ?? false;
  }
}

class FakeShortcuts implements ShortcutPort {
  held = new Map<string, () => void>();
  /** Shortcuts « another app » holds. */
  taken = new Set<string>();
  register(acc: string, cb: () => void) {
    if (this.taken.has(acc)) return false;
    this.held.set(acc, cb);
    return true;
  }
  unregister(acc: string) {
    this.held.delete(acc);
  }
  press(acc: string) {
    const cb = this.held.get(acc);
    if (!cb) throw new Error(`${acc} is not registered`);
    cb();
  }
}

/** The ⌥ watcher: emit() plays a hold; `problem` = macOS has not allowed Input Monitoring (grant() allows it). */
class FakeHoldKey implements HoldKeyPort {
  private on: ((e: HoldEvent) => void) | null = null;
  private status: ((p: string | null) => void) | null = null;
  problem: string | null = null;
  watching = false;
  watch(on: (e: HoldEvent) => void, onStatus: (p: string | null) => void) {
    this.on = on;
    this.status = onStatus;
    this.watching = true;
    onStatus(this.problem);
  }
  unwatch() {
    this.on = this.status = null;
    this.watching = false;
  }
  emit(e: HoldEvent) {
    if (!this.on) throw new Error('⌥ is not watched');
    this.on(e);
  }
  grant() {
    this.problem = null;
    this.status?.(null);
  }
}

describe.skipIf(!haveModels)('push-to-talk and the wake word switch (#57)', () => {
  const engines: Engine[] = [];
  const voices: DesktopVoice[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const v of voices.splice(0)) v.stop();
    for (const e of engines.splice(0)) await e.stop().catch(() => {});
  });

  async function setup(script: ConstructorParameters<typeof FakeProvider>[0], settings: UpdateVoice, holdKey = new FakeHoldKey()) {
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-ptt-'));
    mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
    const fake = new FakeProvider(script);
    const engine = await startEngine({
      dbFile: ':memory:',
      dataDir,
      port: 0,
      providers: () => fake,
      env: {},
      manageLocal: false,
      voice: { modelsDir, micAccess: () => 'granted', requestMicAccess: async () => true },
    });
    engines.push(engine);
    engine.settings.update({ userName: 'Master' });
    await engine.voice!.update({ enabled: true, pttShortcut: 'Alt+Space', ...settings });
    const orb = new FakeOrb();
    const shortcuts = new FakeShortcuts();
    const talk = new DesktopVoice(engine, orb as unknown as ConstructorParameters<typeof DesktopVoice>[1], join(dataDir, 'logs', 'voice.log'), () => {}, shortcuts, holdKey);
    voices.push(talk);
    engine.bus.on((ev) => ev.type === 'voice.updated' && talk.sync()); // as main.ts does
    talk.sync();
    await until('the voice loop', () => talk.running, 60_000);
    return { engine, orb, shortcuts, holdKey, talk };
  }

  /** Feeds a fixture as 100 ms microphone frames (as the orb page sends them). */
  async function say(talk: DesktopVoice, name: string, paceMs = 10) {
    const s = wav(name);
    for (let i = 0; i < s.length; i += 1600) {
      talk.feed(s.subarray(i, i + 1600));
      await sleep(paceMs);
    }
  }

  it('wake word off: microphone closed at rest, no speech-to-text at all; the shortcut runs the wake flow; pressed again it ends it', async () => {
    const stt = vi.spyOn(VoiceModels.prototype, 'transcribe');
    const { engine, orb, shortcuts, talk } = await setup([text('Tomorrow is clear.')], { wakeWord: false });
    expect(orb.micOpen).toBe(false);
    expect(talk.listening).toBe(false);
    expect(engine.voice!.status().ptt).toEqual({ enabled: true, shortcut: 'Alt+Space', error: null, permission: false });

    // « Hi Atlas, create a card… » said near the Mac (frames still in flight): nothing transcribed, nothing wakes
    await say(talk, 'wake-samantha-pause');
    await sleep(500);
    expect(stt).not.toHaveBeenCalled();
    expect(orb.states).toEqual([]);

    // ⌥Space: the orb wakes and the microphone opens, « Yes, Master? », the next sentence is the command
    shortcuts.press('Alt+Space');
    expect(orb.state).toBe('wake');
    expect(orb.micOpen).toBe(true);
    await until('« Yes, Master? »', () => orb.spoken.includes('Yes, Master?') && orb.state === 'listening');
    await say(talk, 'follow-up');
    await until('the reply', () => orb.spoken.includes('Tomorrow is clear.') && orb.state === 'listening');
    const chat = engine.kanban.messages(engine.voiceChat!.id()).filter((m) => m.author === 'user');
    expect(chat.map((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').replace(/^🎙 /, '').replace(/\.$/, ''))).toEqual(['And what about tomorrow?']);
    expect(stt).toHaveBeenCalled();

    // pressed again in the follow-up window: the conversation ends (like Esc), the microphone closes
    shortcuts.press('Alt+Space');
    expect(orb.state).toBe('idle');
    expect(orb.micOpen).toBe(false);
    stt.mockClear();
    await say(talk, 'wake-samantha-pause');
    await sleep(500);
    expect(stt).not.toHaveBeenCalled();
  }, 120_000);

  it('pressed while Atlas speaks: interrupts it and listens', async () => {
    const { orb, shortcuts, talk } = await setup([text('One. Two. Three. Four.')], { wakeWord: false });
    shortcuts.press('Alt+Space');
    await until('listening', () => orb.state === 'listening');
    orb.ms = 3000; // the reply plays slowly
    await say(talk, 'follow-up');
    await until('speaking', () => orb.state === 'speaking');
    shortcuts.press('Alt+Space');
    expect(orb.state).toBe('listening');
    expect(orb.hushes).toBeGreaterThan(0);
    expect(orb.micOpen).toBe(true);
  }, 120_000);

  it('wake word on: the microphone stays open at rest and « Hi Atlas » still wakes', async () => {
    const stt = vi.spyOn(VoiceModels.prototype, 'transcribe');
    const { orb, talk } = await setup([text('Done.')], { wakeWord: true, ptt: false });
    expect(orb.micOpen).toBe(true);
    await say(talk, 'wake-samantha-pause');
    await until('the wake', () => orb.states.includes('wake'));
    expect(stt).toHaveBeenCalled();
    await until('the reply', () => orb.spoken.includes('Done.'));
  }, 120_000);

  it('the shortcut follows the settings and fails loudly when another app holds it', async () => {
    const { engine, shortcuts } = await setup([], { wakeWord: true, ptt: false });
    expect([...shortcuts.held.keys()]).toEqual([]);
    shortcuts.taken.add('Alt+Space');
    await engine.voice!.update({ ptt: true });
    expect([...shortcuts.held.keys()]).toEqual([]);
    expect(engine.voice!.status().ptt.error).toMatch(/⌥ Space could not be registered: another app already uses it/);
    await engine.voice!.update({ pttShortcut: 'Command+Shift+K' });
    expect([...shortcuts.held.keys()]).toEqual(['Command+Shift+K']);
    expect(engine.voice!.status().ptt.error).toBeNull();
    await engine.voice!.update({ ptt: false });
    expect([...shortcuts.held.keys()]).toEqual([]);
  }, 120_000);
  const userMessages = (engine: Engine) =>
    engine.kanban.messages(engine.voiceChat!.id()).filter((m) => m.author === 'user').map((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').replace(/^🎙 /, '').replace(/\.$/, ''));

  it('hold ⌥ (#75): held → listening at once (no « Yes? »), released → sent without waiting for silence, Atlas replies', async () => {
    const { engine, orb, holdKey, shortcuts, talk } = await setup([text('Tomorrow is clear.')], { wakeWord: false, pttShortcut: 'Option' });
    expect(holdKey.watching).toBe(true);
    expect([...shortcuts.held.keys()]).toEqual([]);
    expect(engine.voice!.status().ptt).toEqual({ enabled: true, shortcut: 'Option', error: null, permission: false });
    expect(orb.micOpen).toBe(false);

    holdKey.emit('start');
    expect(orb.state).toBe('listening');
    expect(orb.micOpen).toBe(true);
    // what is said while ⌥ is down, with no trailing silence at all: the release alone sends it
    const s = wav('follow-up');
    let end = s.length;
    while (end > 0 && Math.abs(s[end - 1]!) < 0.01) end--;
    for (let i = 0; i < end; i += 1600) {
      talk.feed(s.subarray(i, Math.min(end, i + 1600)));
      await sleep(5);
    }
    const released = performance.now();
    holdKey.emit('end');
    await until('the message', () => userMessages(engine).length === 1, 15_000);
    const sentAfter = performance.now() - released;
    expect(userMessages(engine)).toEqual(['And what about tomorrow?']);
    await until('the reply', () => orb.spoken.includes('Tomorrow is clear.'));
    expect(orb.spoken).not.toContain('Yes, Master?');
    expect(sentAfter).toBeLessThan(5000); // speech-to-text only, no silence timeout
  }, 120_000);

  it('hold ⌥ while Atlas speaks interrupts it; a cancelled hold (⌥-key, ⌥-click) sends nothing; nothing said → back to rest', async () => {
    const stt = vi.spyOn(VoiceModels.prototype, 'transcribe');
    const { engine, orb, holdKey, talk } = await setup([text('One. Two. Three. Four.')], { wakeWord: false, pttShortcut: 'Option' });
    holdKey.emit('start');
    await say(talk, 'follow-up');
    orb.ms = 3000; // the reply plays slowly
    holdKey.emit('end');
    await until('speaking', () => orb.state === 'speaking');
    const hushes = orb.hushes;
    holdKey.emit('start');
    expect(orb.hushes).toBeGreaterThan(hushes);
    expect(orb.state).toBe('listening');
    await say(talk, 'follow-up');
    stt.mockClear();
    holdKey.emit('cancel');
    expect(orb.state).toBe('idle');
    expect(orb.micOpen).toBe(false);
    await sleep(600);
    expect(stt).not.toHaveBeenCalled();
    expect(userMessages(engine)).toHaveLength(1);

    // held, nothing said, released: no message, the orb goes back to rest
    holdKey.emit('start');
    await say(talk, 'silence');
    holdKey.emit('end');
    await until('rest', () => orb.state === 'idle', 10_000);
    expect(userMessages(engine)).toHaveLength(1);
  }, 120_000);

  it('hold ⌥ without Input Monitoring fails loudly in Settings → Voice, works once allowed; ⌥Space swaps in and out', async () => {
    const holdKey = new FakeHoldKey();
    holdKey.problem = 'Hold ⌥ needs the Input Monitoring permission';
    const { engine, shortcuts } = await setup([], { wakeWord: true, pttShortcut: 'Option' }, holdKey);
    expect(engine.voice!.status().ptt).toMatchObject({ error: 'Hold ⌥ needs the Input Monitoring permission', permission: true });
    holdKey.grant();
    expect(engine.voice!.status().ptt).toMatchObject({ error: null, permission: false });
    await engine.voice!.update({ pttShortcut: 'Alt+Space' });
    expect(holdKey.watching).toBe(false);
    expect([...shortcuts.held.keys()]).toEqual(['Alt+Space']);
    await engine.voice!.update({ pttShortcut: 'Option' });
    expect(holdKey.watching).toBe(true);
    expect([...shortcuts.held.keys()]).toEqual([]);
    await engine.voice!.update({ ptt: false });
    expect(holdKey.watching).toBe(false);
  }, 120_000);
});
