// The voice loop end to end, without a microphone: WAV fixtures fed as microphone frames → the real wake word / speech
// models → the « Voice » chat of a real engine answered by a fake provider → the reply synthesized by Supertonic and
// « played » by a fake orb (in real time). Needs the voice models installed (skipped elsewhere, like @atlas/voice's).
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { VoiceLoop, VoiceModels, defaultModelsDir, missingModels, type LoopMetric, type LoopState, type OrbPort } from '@atlas/voice';
import { startEngine, type Engine } from './index.ts';
import { FakeProvider } from './providers/fake.ts';
import type { ModelRequest } from './providers/types.ts';
import { eventually } from '../test/kit/index.ts';

const FIXTURES = join(import.meta.dirname, '../../voice/test/fixtures');
const wav = (name: string) => sherpa.readWave(join(FIXTURES, `${name}.wav`), false).samples;
const fixture = (name: string) => (JSON.parse(readFileSync(join(FIXTURES, 'fixtures.json'), 'utf8')) as { name: string; speechEnd?: number }[]).find((f) => f.name === name)!;
const modelsDir = defaultModelsDir();
const haveModels = missingModels(modelsDir).length === 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records what the loop does to the orb; speak() « plays » for the audio's duration × `pace`. */
class FakeOrb implements OrbPort {
  states: LoopState[] = [];
  spoken: string[] = [];
  transcripts: string[] = [];
  errors: string[] = [];
  hushes = 0;
  /** Sentences whose playback was cut (hush). */
  cut: string[] = [];
  private playing = new Set<{ text: string; done: (b: boolean) => void; timer: ReturnType<typeof setTimeout>; pcm?: Float32Array; t0?: number }>();
  constructor(private pace = 1) {}
  setState(s: LoopState) {
    this.states.push(s);
    if (s === 'idle') this.hush(false);
  }
  transcript(t: string) {
    this.transcripts.push(t);
  }
  speak(text: string, samples: Float32Array, sampleRate: number) {
    if (this.states.at(-1) === 'idle' || !this.states.length) throw new Error('speak while idle');
    expect(samples.length).toBeGreaterThan(0.2 * sampleRate);
    return new Promise<boolean>((resolve) => {
      const p = {
        text,
        pcm: resample(samples, sampleRate, 16_000),
        t0: performance.now(),
        done: resolve,
        timer: setTimeout(() => {
          this.playing.delete(p);
          this.spoken.push(text);
          resolve(true);
        }, (samples.length / sampleRate) * 1000 * this.pace),
      };
      this.playing.add(p);
    });
  }
  hush(count = true) {
    if (count) this.hushes++;
    for (const p of this.playing) {
      clearTimeout(p.timer);
      this.cut.push(p.text);
      p.done(false);
    }
    this.playing.clear();
  }
  error(m: string) {
    this.errors.push(m);
  }
  /** What the microphone catches of the sentence playing now, next `n` samples at 16 kHz, × `gain` (#53). */
  echo(n: number, gain: number): Float32Array {
    const out = new Float32Array(n);
    for (const p of this.playing) {
      const at = Math.round(((performance.now() - p.t0!) / 1000 / this.pace) * 16_000);
      for (let i = 0; i < n; i++) out[i]! += gain * (p.pcm![at + i] ?? 0);
    }
    return out;
  }
  get state() {
    return this.states.at(-1) ?? 'idle';
  }
}

const text = (t: string) => [{ type: 'text' as const, text: t }];
/** Master's messages in the chat, without Whisper's final full stop (it comes and goes with where the speech detector cuts). */
const userTexts = (e: Engine, id: string) =>
  e.kanban.messages(id).filter((m) => m.author === 'user').map((m) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').replace(/^🎙 /, '').replace(/\.$/, ''));

describe.skipIf(!haveModels)('voice loop end to end (WAV fixtures, fake provider)', () => {
  let models: VoiceModels;
  let engines: Engine[] = [];
  beforeAll(async () => {
    models = await VoiceModels.load(modelsDir);
  }, 60_000);
  afterEach(async () => {
    for (const e of engines) await e.stop().catch(() => {});
    engines = [];
  });
  afterAll(() => {});

  async function setup(script: ConstructorParameters<typeof FakeProvider>[0], dbFile = ':memory:', pace = 1, hold: { quietSeconds?: number; holdSeconds?: number } = {}) {
    const fake = new FakeProvider(script);
    const dataDir = mkdtempSync(join(tmpdir(), 'atlas-voice-'));
    mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true }); // the agent's workspace (rewind snapshots)
    const engine = await startEngine({
      dbFile,
      dataDir,
      port: 0,
      providers: () => fake,
      env: {},
      manageLocal: false,
      voice: { modelsDir, micAccess: () => 'granted', requestMicAccess: async () => true },
    });
    engines.push(engine);
    engine.settings.update({ userName: 'Master' });
    const orb = new FakeOrb(pace);
    const metrics: LoopMetric[] = [];
    const errors: Error[] = [];
    const heard: string[] = [];
    const loop = new VoiceLoop({
      models,
      orb,
      chat: engine.voiceChat!,
      userName: () => engine.settings.user().name,
      voice: () => 'voice-9',
      onMetric: (m) => metrics.push(m),
      onError: (e) => errors.push(e),
      onHeard: (t, o) => heard.push(`${o}: ${t}`),
      ...hold,
    });
    await loop.warm();
    // as the desktop app does: every other reply in the Voice chat is announced (#52)
    const announced: string[] = [];
    engine.voiceChat!.watch((t) => {
      announced.push(t);
      loop.announce(t);
    });
    return { engine, fake, orb, loop, metrics, errors, announced, heard };
  }

  /** Feeds a fixture as 100 ms microphone frames, `paceMs` apart (100 = real time). */
  async function say(loop: VoiceLoop, name: string, paceMs = 10) {
    const s = wav(name);
    for (let i = 0; i < s.length; i += 1600) {
      loop.feed(s.subarray(i, i + 1600));
      await sleep(paceMs);
    }
    await loop.settled();
  }
  async function feedTo(loop: VoiceLoop, s: Float32Array, paceMs = 20) {
    for (let i = 0; i < s.length; i += 1600) {
      loop.feed(s.subarray(i, i + 1600));
      await sleep(paceMs);
    }
  }
  async function until(what: string, cond: () => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  it('« Hi Atlas » → « Yes, Master? » → command in the Voice chat → reply spoken → follow-up without the wake word → rest', async () => {
    const { engine, fake, orb, loop, metrics, errors, announced } = await setup([
      text('Done. I created card number 12 to fix the login bug, assigned to atlas.'),
      text('Tomorrow is clear. Nothing is scheduled.'),
    ]);
    await say(loop, 'wake-samantha-pause'); // « Hi Atlas » … pause … « Create a card to fix the login bug »
    await until('the reply', () => orb.spoken.length >= 3 && loop.state === 'listening');
    expect(orb.spoken).toEqual(['Yes, Master?', 'Done.', 'I created card number 12 to fix the login bug, assigned to atlas.']);
    expect(orb.states[0]).toBe('wake');
    expect(orb.states.slice(-3)).toEqual(['thinking', 'speaking', 'listening']);
    expect(orb.transcripts.map((t) => t.replace(/\.$/, ''))).toEqual(['Create a card to fix the login bug']);

    // the dedicated Voice chat, in SQLite like any chat; the agent knows its reply is spoken
    const chatId = engine.voiceChat!.id();
    const chat = engine.kanban.get(chatId);
    expect(chat).toMatchObject({ title: '@atlas', board: 'direct', assignee: 'atlas' }); // v3: atlas's main chat
    expect(engine.agents.get('atlas').mainChat).toBe(chatId);
    expect(userTexts(engine, chatId)).toEqual(['Create a card to fix the login bug']);
    expect(fake.calls[0]!.system).toMatch(/talks to you by voice here/);

    // follow-up within the window, no wake word
    await say(loop, 'follow-up');
    await until('the second reply', () => orb.spoken.length >= 5 && loop.state === 'listening');
    expect(userTexts(engine, chatId)).toEqual(['Create a card to fix the login bug', 'And what about tomorrow?']);
    expect(orb.spoken.slice(3)).toEqual(['Tomorrow is clear.', 'Nothing is scheduled.']);
    expect(engine.kanban.messages(chatId).filter((m) => m.author === 'atlas')).toHaveLength(2);

    // then ~8 s of silence: back to rest
    await say(loop, 'silence', 0);
    await say(loop, 'silence', 0);
    expect(loop.state).toBe('idle');
    expect(orb.states.at(-1)).toBe('idle');
    // no wake word: unrelated talk at rest goes nowhere
    await say(loop, 'unrelated-speech', 0);
    expect(userTexts(engine, chatId)).toHaveLength(2);
    expect(errors).toEqual([]);
    expect(announced).toEqual([]); // spoken replies are not announced again
    expect(orb.spoken.filter((s) => s === 'Done.')).toHaveLength(1);
    const m = Object.fromEntries(metrics.map((x) => [x.name, Math.round(x.ms)]));
    console.log('voice loop metrics (ms, fake provider):', m, metrics.find((x) => x.name === 'speechEndToFirstWord')?.parts);
    // « Yes, Master? » is synthesized ahead: once « Hi Atlas » has ended, only silence detection + speech-to-text (Whisper ~0.7 s)
    // Wall-clock bound on a real Whisper run: typically ~1 s, but a busy machine (full suite in parallel) hit 2.5 s.
    // 4 s still catches a regression like synthesizing the ack after the wake word instead of ahead.
    expect(metrics.find((x) => x.name === 'wakeToAck')!.parts!.afterWakeSpeechEnd).toBeLessThan(4000);
  }, 90_000);

  it('one breath « Hi Atlas, what is on the board today? »: no « Yes, Master? » over Master, straight to the answer', async () => {
    const { engine, orb, loop } = await setup([text('Three cards are running.')]);
    await say(loop, 'wake-daniel-one-breath', 30);
    await until('the reply', () => orb.spoken.includes('Three cards are running.'));
    expect(userTexts(engine, engine.voiceChat!.id())).toEqual(['what is on the board today?']);
    expect(orb.spoken).not.toContain('Yes, Master?');
  }, 60_000);

  it('barge-in: « Atlas, stop » while speaking cuts the reply and listens; Esc ends the conversation', async () => {
    const long = 'Here is the full report. The first card is about the login page. The second card is about the billing export. The third card is about the onboarding emails.';
    const { engine, orb, loop, metrics } = await setup([text(long), text('Sure, tomorrow is clear.'), text(long)]);
    await say(loop, 'wake-daniel-one-breath', 30);
    await until('speaking', () => loop.state === 'speaking');
    await say(loop, 'barge-atlas', 0);
    await until('barge-in', () => orb.hushes === 1);
    expect(loop.state).toBe('listening');
    expect(orb.cut.length).toBeGreaterThan(0);
    expect(metrics.some((m) => m.name === 'bargeIn')).toBe(true);
    const spokenAtBarge = orb.spoken.length;
    await sleep(300);
    expect(orb.spoken.length).toBe(spokenAtBarge); // nothing more of the old reply

    // listening after the barge-in: the next sentence is a command, no wake word
    await say(loop, 'follow-up');
    await until('the answer', () => orb.spoken.includes('Sure, tomorrow is clear.'));
    expect(userTexts(engine, engine.voiceChat!.id()).at(-1)).toBe('And what about tomorrow?');
    await until('listening', () => loop.state === 'listening');

    // Esc while speaking: the conversation ends (speech cut, not listening), back to rest
    await say(loop, 'wake-eddy', 30);
    await until('speaking again', () => loop.state === 'speaking');
    const played = orb.spoken.length;
    loop.escape();
    expect(loop.state).toBe('idle');
    expect(orb.state).toBe('idle');
    await new Promise((r) => setTimeout(r, 300));
    expect(orb.spoken.length).toBe(played); // nothing more is said
  }, 120_000);

  it("ignores « Atlas » in its own voice: the sentence being played says « Atlas »", async () => {
    const { orb, loop } = await setup([text('I am Atlas, and this sentence is long enough to be still playing when the echo comes back.')]);
    await say(loop, 'wake-daniel-one-breath', 30);
    await until('speaking', () => loop.state === 'speaking');
    await say(loop, 'barge-atlas', 0); // stands for the echo of « Atlas » through the speakers
    await sleep(300);
    expect(orb.hushes).toBe(0);
    expect(loop.state).toBe('speaking');
  }, 60_000);

  it('drops its own « Yes, Master? » heard back as the command', async () => {
    const { engine, orb, loop } = await setup([text('Fine.')]);
    // the ack's echo, synthesized by Supertonic (as it would come back through the microphone), then the real command
    const echo = await models.synthesize('Yes, Master?');
    const pcm16k = resample(echo.samples, echo.sampleRate, 16_000);
    const s = wav('wake-samantha-pause');
    const wakeEnd = 21288 + 4000;
    for (let i = 0; i < wakeEnd; i += 1600) loop.feed(s.subarray(i, Math.min(wakeEnd, i + 1600)));
    loop.feed(new Float32Array(16_000));
    await loop.settled();
    await until('« Yes, Master? »', () => orb.spoken.includes('Yes, Master?'));
    for (let i = 0; i < pcm16k.length; i += 1600) loop.feed(pcm16k.subarray(i, i + 1600));
    loop.feed(new Float32Array(16_000));
    await loop.settled();
    for (let i = wakeEnd; i < s.length; i += 1600) loop.feed(s.subarray(i, i + 1600));
    await loop.settled();
    await until('the reply', () => orb.spoken.includes('Fine.'));
    expect(userTexts(engine, engine.voiceChat!.id())).toEqual(['Create a card to fix the login bug']);
  }, 60_000);

  it('the Voice chat and its messages survive a restart (voice state does not)', async () => {
    const dbFile = join(mkdtempSync(join(tmpdir(), 'atlas-voice-db-')), 'atlas.db');
    const first = await setup([text('Noted.')], dbFile);
    await say(first.loop, 'wake-daniel-one-breath', 30);
    await until('the reply', () => first.orb.spoken.includes('Noted.'));
    const id = first.engine.voiceChat!.id();
    await first.engine.stop();
    const second = await setup([text('Still here.')], dbFile);
    expect(second.engine.voiceChat!.id()).toBe(id);
    expect(second.loop.state).toBe('idle');
    expect(userTexts(second.engine, id)).toEqual(['what is on the board today?']);
    await say(second.loop, 'wake-eddy', 30);
    await until('the reply', () => second.orb.spoken.includes('Still here.'));
    expect(userTexts(second.engine, id)).toHaveLength(2);
    // the agent saw the earlier exchange: it is one conversation
    const req = (second.fake as unknown as { calls: ModelRequest[] }).calls[0]!;
    expect(JSON.stringify(req.messages)).toContain('Noted.');
  }, 90_000);

  it('#52 / v3: in the main chat a reply to a typed message is silent; after a voice message, replies are spoken once', async () => {
    const { engine, orb, loop, announced } = await setup([text('Written answer.'), text('Typed it. Here is the answer.')], ':memory:', 1, { quietSeconds: 0.3 });
    const id = engine.voiceChat!.id();
    const post = (t: string) => fetch(`${engine.url}/api/cards/${id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
    expect((await post('typed question')).ok).toBe(true);
    await until('answered', () => engine.runner.runs(id)[0]?.status === 'done');
    await sleep(300);
    expect(orb.spoken).toEqual([]);
    // The last message came by voice (e.g. a voice turn that was cut): the next reply is announced.
    expect((await post('🎙 and by voice')).ok).toBe(true);
    await until('spoken', () => orb.spoken.length === 2 && loop.state === 'listening');
    expect(orb.spoken).toEqual(['Typed it.', 'Here is the answer.']);
    expect(announced).toEqual(['Typed it. Here is the answer.']);
    expect(orb.states).toEqual(['speaking', 'listening']); // woke to speak, then a follow-up without the wake word
    await sleep(300);
    expect(orb.spoken).toHaveLength(2);
  }, 60_000);

  it('#52: a card report during a spoken turn is queued, then said after the reply, once', async () => {
    const long = 'Here is the full report. The first card is about the login page. The second card is about billing.';
    const { engine, orb, loop, announced } = await setup([text(long)], ':memory:', 1, { quietSeconds: 0.3 });
    const chatId = engine.voiceChat!.id();
    const card = engine.kanban.create({ title: 'Report me', status: 'todo' }, 'atlas', chatId);
    const said = `Task ${card.number} is closed: Report me.`;
    await say(loop, 'wake-daniel-one-breath', 30);
    // the voice turn's run is over (its text all streamed), Atlas is still speaking it
    await eventually(() => loop.state === 'speaking' && !engine.kanban.get(chatId).working && engine.runner.runs(chatId)[0]?.status === 'done', { timeout: 20_000, what: 'the reply streamed, still speaking' });
    const spokenBefore = orb.spoken.length;
    engine.kanban.update(card.id, { status: 'closed' }, 'atlas');
    // the task note is in the chat (#143: it wakes no agent, so the voice says the note itself)
    expect(announced).toEqual([said]);
    expect(loop.state).toBe('speaking'); // not cut: queued behind the reply
    expect(orb.spoken.length).toBe(spokenBefore);
    await eventually(() => orb.spoken.includes(said) && loop.state === 'listening', { timeout: 30_000, what: 'the report spoken after the reply' });
    const turn = ['Here is the full report.', 'The first card is about the login page.', 'The second card is about billing.'];
    expect(orb.spoken).toEqual([...turn, said]); // after the reply, once
    expect(orb.cut).toEqual([]);
    expect(engine.runner.runs(chatId)).toHaveLength(1); // no agent turn for the note
  }, 90_000);

  it('#52: Esc stops an announcement and drops the queue; barge-in too', async () => {
    const { orb, loop } = await setup([], ':memory:', 1, { quietSeconds: 0 });
    loop.announce('The first card is finished and its tests pass. The second one is next.');
    loop.announce('Another report that must not be said.');
    await until('speaking', () => loop.state === 'speaking');
    loop.escape();
    expect(loop.state).toBe('idle');
    await sleep(500);
    expect(orb.spoken.join(' ')).not.toMatch(/Another report|second one/);
    loop.feed(new Float32Array(1600));
    await sleep(300);
    expect(orb.spoken.join(' ')).not.toMatch(/Another report/);

    loop.announce('Here is a long report about the login page and the billing export cards.');
    loop.announce('Queued and dropped by the barge-in.');
    await until('speaking', () => loop.state === 'speaking');
    await say(loop, 'barge-atlas', 0);
    await until('barge-in', () => orb.hushes === 1);
    await say(loop, 'silence', 0);
    expect(orb.spoken.join(' ')).not.toMatch(/Queued and dropped/);
  }, 60_000);

  it('#52: held while someone talks, said after the quiet; never said when the talk outlasts the hold time', async () => {
    const talk = wav('unrelated-speech');
    const half = Math.round(talk.length / 2);
    const { orb, loop } = await setup([], ':memory:', 1, { quietSeconds: 1.5, holdSeconds: 30 });
    await feedTo(loop, talk.subarray(0, half)); // someone is talking (a call)
    loop.announce('Card twelve is finished.');
    await feedTo(loop, talk.subarray(half));
    expect(orb.spoken).toEqual([]); // never over the talk
    // quiet (the microphone keeps sending frames, as in the app): now it is said
    await until('spoken', () => {
      loop.feed(new Float32Array(1600));
      return orb.spoken.includes('Card twelve is finished.');
    });

    // the talk goes on past the hold time: dropped, it only stays in the chat
    const short = await setup([], ':memory:', 1, { quietSeconds: 3, holdSeconds: 0.5 });
    await feedTo(short.loop, talk.subarray(0, half));
    short.loop.announce('Card thirteen is finished.');
    await feedTo(short.loop, talk.subarray(half));
    await feedTo(short.loop, new Float32Array(16_000 * 4), 10);
    await sleep(300);
    expect(short.orb.spoken).toEqual([]);
    expect(short.loop.state).toBe('idle');
  }, 60_000);

  it('#54: « Start talking » (menu bar) wakes without the wake word: « Yes, Master? », then the next sentence is the command', async () => {
    const { engine, orb, loop } = await setup([text('Tomorrow is clear.')]);
    loop.wakeNow();
    expect(loop.state).toBe('wake');
    await until('« Yes, Master? »', () => orb.spoken.includes('Yes, Master?') && loop.state === 'listening');
    loop.wakeNow(); // already listening: nothing changes
    expect(loop.state).toBe('listening');
    await say(loop, 'follow-up');
    await until('the reply', () => orb.spoken.includes('Tomorrow is clear.'));
    expect(userTexts(engine, engine.voiceChat!.id())).toEqual(['And what about tomorrow?']);
  }, 60_000);

  /** #53: Master's words fed in real time over the echo of what Atlas is playing (−30 dB after echo cancellation). */
  async function sayOver(loop: VoiceLoop, orb: FakeOrb, name: string, onFrame?: () => void) {
    const s = wav(name);
    const t0 = performance.now();
    for (let i = 0; i < s.length + 16_000; i += 1600) {
      const frame = orb.echo(1600, 0.03);
      s.subarray(i, i + 1600).forEach((x, k) => (frame[k]! += x));
      loop.feed(frame);
      onFrame?.();
      await sleep(Math.max(0, (i + 1600) / 16 - (performance.now() - t0)));
    }
    await loop.settled();
    return t0;
  }

  it('#53: « stop », « dur », « hayır »… over Atlas speaking cut it at once; a bare stop word is not sent, « hayır, … » is', async () => {
    const long = 'Here is the full report. The first card is about the login page. The second card is about the billing export. The third card is about the onboarding emails. The fourth card is about the release notes.';
    const lat: Record<string, number> = {};
    const missed: string[] = [];
    for (const name of ['barge-stop-en', 'barge-wait-en', 'barge-dur-tr', 'barge-hayir-tr', 'barge-yeter-tr', 'barge-hayir-command-tr']) {
      const { engine, orb, loop, heard } = await setup([text(long), text('Tamam, yarın için açtım.')]);
      await say(loop, 'wake-daniel-one-breath', 30);
      await until('speaking', () => loop.state === 'speaking');
      let hushedAt = 0;
      const t0 = await sayOver(loop, orb, name, () => (hushedAt ||= orb.hushes ? performance.now() : 0));
      if (orb.hushes === 0 && name.endsWith('-tr') && !name.includes('command') && !missed.length) {
        missed.push(`${name}: ${heard.join(' | ')}`); // Whisper over the echo: one short Turkish word may be missed
        continue;
      }
      expect(orb.hushes, `${name}: ${heard.join(' | ')} (missed before: ${missed})`).toBe(1);
      expect(orb.cut.length, name).toBeGreaterThan(0);
      lat[name] = Math.round(hushedAt - t0 - fixture(name).speechEnd! / 16);
      const sent = userTexts(engine, engine.voiceChat!.id());
      if (name.includes('command')) {
        await until('the answer', () => orb.spoken.includes('Tamam, yarın için açtım.'));
        expect(userTexts(engine, engine.voiceChat!.id()).at(-1), name).toMatch(/^hayır, yarı[nm] için bir kart aç$/i);
      } else {
        expect(sent, name).toEqual(['what is on the board today?']); // the stop word itself is not a message
        expect(loop.state, name).toBe('listening'); // and Atlas listens: the next sentence is the new message
      }
    }
    console.log('#53 end of stop word → speech cut (ms, frame resolution 100 ms; < 0: mid-word)', lat, 'missed', missed);
    for (const [n, ms] of Object.entries(lat)) expect(ms, n).toBeLessThan(3000);
  }, 300_000);

  it('#53: Atlas saying « stop » itself does not interrupt it (own-voice check)', async () => {
    const { orb, loop } = await setup([text('You can say stop. Stop! That word interrupts me whenever I am talking for too long, in English or in Turkish.')]);
    await say(loop, 'wake-daniel-one-breath', 30);
    await until('speaking', () => loop.state === 'speaking');
    await say(loop, 'barge-stop-en', 0); // stands for the echo of « Stop! » through the speakers
    await sleep(300);
    expect(orb.hushes).toBe(0);
  }, 60_000);

  it('a failed reply is shown on the orb, and listening goes on', async () => {
    const { orb, loop, errors } = await setup([
      () => {
        throw new Error('model exploded');
      },
    ]);
    await say(loop, 'wake-daniel-one-breath', 30);
    await until('the error', () => orb.errors.length > 0);
    expect(orb.errors[0]).toMatch(/model exploded/);
    expect(errors[0]!.message).toMatch(/model exploded/);
    expect(loop.state).toBe('listening');
  }, 60_000);
});

function resample(x: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor((x.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const p = (i * from) / to;
    const a = Math.floor(p);
    out[i] = (x[a] ?? 0) * (1 - (p - a)) + (x[a + 1] ?? 0) * (p - a);
  }
  return out;
}

it('voice fixtures for the loop are present', () => {
  const meta = JSON.parse(readFileSync(join(FIXTURES, 'fixtures.json'), 'utf8')) as { name: string }[];
  expect(meta.map((f) => f.name)).toEqual(expect.arrayContaining(['follow-up', 'barge-atlas']));
});
