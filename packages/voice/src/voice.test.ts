import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MODEL_IDS,
  SAMPLE_RATE,
  VoiceModelError,
  VoiceModels,
  VoicePipeline,
  afterBargeIn,
  afterWakePhrase,
  defaultModelsDir,
  fetchModel,
  isInstalled,
  missingModels,
  pauseGraceSeconds,
  sensitivitySettings,
  speechLang,
  saysStopWord,
  splitSentences,
  stopWord,
  type ModelSpec,
  type VoiceEvent,
} from './index.ts';

const FIXTURES = join(import.meta.dirname, '../test/fixtures');
interface Fixture {
  name: string;
  samples: number;
  wakeEnd?: number;
  pauseAt?: number;
  speechEnd?: number;
}
const fixtures = JSON.parse(readFileSync(join(FIXTURES, 'fixtures.json'), 'utf8')) as Fixture[];
const fixture = (name: string) => fixtures.find((f) => f.name === name)!;
const wav = (name: string) => sherpa.readWave(join(FIXTURES, `${name}.wav`), false).samples;

describe('text helpers', () => {
  it('finds the wake phrase at the start only', () => {
    expect(afterWakePhrase('Hi Atlas, what is on the board today?')).toBe('what is on the board today?');
    expect(afterWakePhrase('Hey, Atlas.')).toBe('');
    expect(afterWakePhrase('Hi Aglas.')).toBe('');
    expect(afterWakePhrase('Hi at last, open the board')).toBe('open the board');
    expect(afterWakePhrase('I Atlas. What time is it?')).toBe('What time is it?');
    expect(afterWakePhrase('Okay so hi Atlas create a card')).toBe('create a card');
    expect(afterWakePhrase('I bought a new Atlas of the World.')).toBeUndefined();
    expect(afterWakePhrase('Atlas Shrugged is a long book.')).toBeUndefined();
    expect(afterWakePhrase('What is on the board?')).toBeUndefined();
    expect(afterWakePhrase('I went for a walk by the river. Hi Atlas, create a card.')).toBe('create a card.');
    expect(afterWakePhrase('My atlas, hi there. The atlas is old.')).toBeUndefined();
    // low sensitivity: the exact phrase only
    expect(afterWakePhrase('Hey, Atlas, open the board.', true)).toBe('open the board.');
    expect(afterWakePhrase('Hi at last, open the board', true)).toBeUndefined();
    expect(afterWakePhrase('I Atlas. What time is it?', true)).toBeUndefined();
  });

  it('barge-in: « Atlas » anywhere, or a stop word opening the utterance, English or Turkish (card #53)', () => {
    expect(afterBargeIn('Atlas, stop.')).toBe('stop.');
    expect(afterBargeIn('Okay Atlas what time is it')).toBe('what time is it');
    for (const t of ['Stop!', 'stop', 'Wait. Wait. Wait.', 'No.', 'Nope', 'Okay, wait.', 'Hayır.', 'Bekle. Bekle.', 'Sus!', 'SUS', 'Yeter', 'Yeter artık.', 'Dur.', 'Duş, bir dakika.', 'Düş', 'Душ', 'СУС'])
      expect(afterBargeIn(t), t).toBeTruthy();
    expect(afterBargeIn('Dur.')).toBe('Dur.');
    expect(afterBargeIn('No, I meant tomorrow.')).toBe('No, I meant tomorrow.');
    expect(afterBargeIn('Hayır, yarın için.')).toBe('Hayır, yarın için.');
    // not a stop word, or not at the start: Atlas keeps talking
    for (const t of ['Nothing is scheduled.', 'Now open the board.', 'Notice the build.', 'Durum nedir?', 'Beklenen bu.', 'I said no.', 'Stock prices are up.', 'Waiting list.', 'Thank you.', ''])
      expect(afterBargeIn(t), t).toBeUndefined();
    expect(stopWord('Duş, bir dakika')).toEqual({ word: 'dur', at: 0 });
    expect(stopWord('okay, hayir')?.word).toBe('hayır');
    for (const t of ['Hayyuz.', 'Hayush', 'Hayırs']) expect(stopWord(t)?.word, t).toBe('hayır');
    expect(stopWord('Hey!')).toBeUndefined();
    expect(stopWord('Stop!')?.word).toBe('stop');
    // Atlas's echo caught in the same transcript: the stop word opening the last sentence counts
    expect(afterBargeIn('No cards are blocked. And the third one is about. Stop! Wait')).toBe('Wait');
    expect(stopWord('No cards are blocked. Stop!')).toEqual({ word: 'stop', at: 22 });
    expect(afterBargeIn("the onboarding emails. Hayır, yarın için.")).toBe('Hayır, yarın için.');
    expect(afterBargeIn("You will have to wait for the build.")).toBeUndefined();
    expect(saysStopWord('No cards are blocked.', 'no')).toBe(true);
    expect(saysStopWord('Nothing is blocked, nobody waits.', 'no')).toBe(false);
    expect(saysStopWord('Testleri bekle, sonra merge et.', 'bekle')).toBe(true);
    expect(saysStopWord('Durum iyi.', 'dur')).toBe(false);
  });

  it('maps wake sensitivity to the speech threshold and the strict phrase', () => {
    expect(sensitivitySettings(0.5)).toEqual({ vadThreshold: 0.5, strictWake: false });
    expect(sensitivitySettings(0)).toEqual({ vadThreshold: 0.7, strictWake: true });
    expect(sensitivitySettings(1)).toEqual({ vadThreshold: 0.3, strictWake: false });
    expect(sensitivitySettings(7).vadThreshold).toBe(0.3);
  });

  it('splits replies into sentences, not on abbreviations, without markdown', () => {
    expect(splitSentences('# Board\nThree cards, **two** blocked. The build ended at 2:14 a.m. and passed! Done?')).toEqual([
      'Board',
      'Three cards, two blocked.',
      'The build ended at 2:14 a.m. and passed!',
      'Done?',
    ]);
    expect(splitSentences('```ts\ncode()\n```\n- a\n- b')).toEqual(['- a', '- b']);
  });

  it('speaks a sentence in Turkish when it is Turkish, English otherwise', () => {
    expect(speechLang('Good evening, Master. You have 3 cards in review.')).toBe('en');
    expect(speechLang('The build ended at 2:14 a.m. and passed!')).toBe('en');
    expect(speechLang('Merhaba Master, uyandırma kelimesi kartını incelemeye aldım.')).toBe('tr');
    expect(speechLang("Pull request'i merge ettim, testler yeşil.")).toBe('tr');
    expect(speechLang('Saat 14:30, kart yüzde 95 tamam.')).toBe('tr');
    expect(speechLang('Tamam, bir kart açtım.')).toBe('tr');
    expect(speechLang('Über das Atlas board.')).toBe('en');
  });
});

describe('model download', () => {
  let server: Server;
  let base: string;
  const files: Record<string, Buffer> = {};
  const ranges: (string | undefined)[] = [];
  beforeAll(async () => {
    const src = mkdtempSync(join(tmpdir(), 'voice-src-'));
    mkdirSync(join(src, 'm'));
    writeFileSync(join(src, 'm', 'model.onnx'), 'weights');
    writeFileSync(join(src, 'm', 'tokens.txt'), 'a 0');
    execFileSync('tar', ['-cjf', join(src, 'm.tar.bz2'), '-C', src, 'm']);
    files['/m.tar.bz2'] = readFileSync(join(src, 'm.tar.bz2'));
    files['/one.onnx'] = Buffer.from('single file model');
    files['/big.bin'] = Buffer.alloc(256 * 1024, 7);
    server = createServer((req, res) => {
      const path = (req.url ?? '').replace(/^\/stall/, '');
      const body = files[path];
      if (!body) return void res.writeHead(404).end();
      ranges.push(req.headers.range);
      const from = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
      if (from >= body.length) return void res.writeHead(416).end();
      const rest = body.subarray(from);
      res.writeHead(from ? 206 : 200, { 'content-length': rest.length });
      // /stall/…: sends the first half, then hangs (an interrupted download)
      if (req.url?.startsWith('/stall')) res.write(rest.subarray(0, rest.length / 2));
      else res.end(rest);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  it('downloads, verifies and unpacks an archive, then a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-models-'));
    const archive: ModelSpec = { id: 'a', url: `${base}/m.tar.bz2`, sha256: sha(files['/m.tar.bz2']!), kind: 'tar.bz2', files: ['model.onnx', 'tokens.txt'], bytes: 0 };
    const single: ModelSpec = { id: 'b', url: `${base}/one.onnx`, sha256: sha(files['/one.onnx']!), kind: 'file', fileName: 'one.onnx', files: ['one.onnx'], bytes: 0 };
    let progress = 0;
    await fetchModel(dir, archive, (p) => (progress = p.received));
    await fetchModel(dir, single);
    expect(progress).toBe(files['/m.tar.bz2']!.length);
    expect(isInstalled(dir, archive) && isInstalled(dir, single)).toBe(true);
    expect(readFileSync(join(dir, 'a', 'model.onnx'), 'utf8')).toBe('weights');
    expect(readdirSync(dir).sort()).toEqual(['a', 'b']); // no temp files left
  });

  it('rejects a wrong checksum or a 404 and keeps nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-models-'));
    const bad: ModelSpec = { id: 'a', url: `${base}/m.tar.bz2`, sha256: '0'.repeat(64), kind: 'tar.bz2', files: ['model.onnx'], bytes: 0 };
    await expect(fetchModel(dir, bad)).rejects.toThrow(/sha256 mismatch/);
    await expect(fetchModel(dir, { ...bad, url: `${base}/nope` })).rejects.toThrow(/HTTP 404/);
    expect(readdirSync(dir)).toEqual([]);
    expect(isInstalled(dir, bad)).toBe(false);
  });

  it('resumes an interrupted download where it stopped, and still verifies the whole file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-models-'));
    const big = files['/big.bin']!;
    const spec: ModelSpec = { id: 'c', url: `${base}/stall/big.bin`, sha256: sha(big), kind: 'file', fileName: 'big.bin', files: ['big.bin'], bytes: big.length };
    const abort = new AbortController();
    let seen = 0;
    const first = fetchModel(dir, spec, (p) => {
      seen = p.received;
      if (p.received >= big.length / 2) setTimeout(() => abort.abort(), 100); // the stalled connection is cut
    }, abort.signal);
    await expect(first).rejects.toThrow();
    expect(seen).toBe(big.length / 2);
    expect(readdirSync(dir)).toEqual(['.c.download']); // what arrived is kept
    const kept = statSync(join(dir, '.c.download')).size;
    expect(kept).toBe(big.length / 2);
    ranges.length = 0;
    const progress: number[] = [];
    await fetchModel(dir, { ...spec, url: `${base}/big.bin` }, (p) => progress.push(p.received));
    expect(ranges).toEqual([`bytes=${kept}-`]);
    expect(progress[0]).toBe(kept);
    expect(progress.at(-1)).toBe(big.length);
    expect(isInstalled(dir, spec)).toBe(true);
    expect(readdirSync(dir)).toEqual(['c']);

    // a stale part that doesn't match: checksum fails, the part is dropped, the next try starts over
    const dir2 = mkdtempSync(join(tmpdir(), 'voice-models-'));
    writeFileSync(join(dir2, '.c.download'), Buffer.alloc(1000, 1));
    await expect(fetchModel(dir2, { ...spec, url: `${base}/big.bin` })).rejects.toThrow(/sha256 mismatch/);
    expect(readdirSync(dir2)).toEqual([]);
    await fetchModel(dir2, { ...spec, url: `${base}/big.bin` });
    expect(isInstalled(dir2, spec)).toBe(true);
  });

  it('fails loudly when models are missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'voice-empty-'));
    expect(missingModels(dir)).toEqual(MODEL_IDS);
    await expect(VoiceModels.load(dir)).rejects.toThrow(VoiceModelError);
    await expect(VoiceModels.load(dir)).rejects.toThrow(/voice models missing in .*: vad, stt, tts/);
  });
});

// The real models (~850 MB) are not part of the repo: these run where they are installed (default dir or
// ATLAS_VOICE_MODELS) and are reported as skipped elsewhere.
const modelsDir = defaultModelsDir();
const haveModels = missingModels(modelsDir).length === 0;
if (!haveModels) console.warn(`voice: models missing in ${modelsDir}, model tests skipped`);

describe.skipIf(!haveModels)('with the real models', () => {
  let models: VoiceModels;
  beforeAll(async () => {
    models = await VoiceModels.load(modelsDir);
  }, 60_000);

  /** Feeds audio in 100 ms frames, like the microphone will; `paceMs` waits between frames (100 = real time). */
  async function run(names: string[], setup?: (p: VoicePipeline) => void, paceMs = 0) {
    const events: VoiceEvent[] = [];
    const p = new VoicePipeline(models, { onEvent: (e) => events.push(e) });
    setup?.(p);
    for (const n of names) {
      const s = wav(n);
      for (let i = 0; i < s.length; i += 1600) {
        p.feed(s.subarray(i, i + 1600));
        if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
      }
    }
    await p.settled();
    return events;
  }
  const commands = (ev: VoiceEvent[]) => ev.flatMap((e) => (e.type === 'command' ? [e.text] : []));

  it('wakes on « Hi Atlas » + command said in one breath', async () => {
    const ev = await run(['wake-daniel-one-breath']);
    expect(ev.map((e) => e.type)).toEqual(['wake', 'command']);
    expect(commands(ev)).toEqual(['what is on the board today?']);
  }, 30_000);

  it('wakes on a bare « Hi Atlas », then takes the next sentence as the command', async () => {
    const ev = await run(['wake-samantha-pause']);
    expect(ev.map((e) => e.type)).toEqual(['wake', 'awaiting', 'command']);
    expect(commands(ev).map((c) => c.replace(/\.$/, ''))).toEqual(['Create a card to fix the login bug']);
  }, 30_000);

  it('wakes again and again in one long stream, with talk and silence in between', async () => {
    const ev = await run(['unrelated-speech', 'wake-eddy', 'near-miss-atlas', 'silence', 'wake-daniel-one-breath', 'unrelated-speech', 'wake-samantha-pause']);
    expect(ev.filter((e) => e.type === 'wake')).toHaveLength(3);
    const cmds = commands(ev).map((c) => c.toLowerCase());
    expect(cmds).toHaveLength(3);
    expect(cmds[0]).toMatch(/^what time (is|was) it in tokyo\?$/); // Parakeet hears either in this voice
    expect(cmds.slice(1)).toEqual(['what is on the board today?', 'create a card to fix the login bug']);
  }, 60_000);

  it('does not wake on silence, unrelated speech or « an atlas of the world »', async () => {
    for (const n of ['silence', 'unrelated-speech', 'near-miss-atlas']) expect(await run([n]), n).toEqual([]);
  }, 30_000);

  it('times out when no command follows the wake word', async () => {
    const ev = await run(['silence', 'silence'], (p) => p.startCapture());
    expect(ev.map((e) => e.type)).toEqual(['timeout']);
  }, 30_000);

  it('keeps listening through a breath mid-command and sends it whole (card #40)', async () => {
    const follow = await run(['follow-up-pause'], (p) => p.startCapture());
    expect(follow.map((e) => e.type)).toEqual(['command']);
    expect(commands(follow)[0]!.toLowerCase()).toMatch(/^create a card to fix the login bug[.,]? and assign it to me\.?$/);
    const wake = await run(['wake-pause-mid-command'], undefined, 100); // paced: the early wake marks it as a command
    expect(wake.map((e) => e.type)).toEqual(['wake', 'command']);
    expect(commands(wake)[0]!.toLowerCase()).toMatch(/^what is on the board[.,?]? and what is blocked\??$/);
  }, 30_000);

  it('ends a short command quickly and a long one after a longer silence (end of speech → sent)', async () => {
    const tails: Record<string, number> = {};
    for (const [name, capture] of [['follow-up', true], ['barge-atlas', true], ['follow-up-pause', true], ['wake-pause-mid-command', false]] as const) {
      const f = fixture(name);
      const cmd = (await run([name], capture ? (p) => p.startCapture() : undefined, capture ? 0 : 100)).find((e) => e.type === 'command');
      if (cmd?.type !== 'command') throw new Error(`no command in ${name}`);
      tails[name] = Math.round(((cmd.endSample - f.speechEnd!) / SAMPLE_RATE) * 1000);
      expect(Math.abs(cmd.tailMs - tails[name]!), name).toBeLessThan(350); // reported tail ≈ measured one
    }
    console.log('end of speech → sent to speech-to-text (ms)', tails);
    // before the pause grace: ~0.9 s for all; now ~1.25 s for a short command, up to ~1.5 s after long talk
    expect(tails['follow-up']).toBeLessThan(1400);
    expect(tails['barge-atlas']).toBeLessThan(1500);
    expect(tails['follow-up-pause']).toBeLessThan(1900);
  }, 60_000);

  it('transcribes a fixture sentence exactly', async () => {
    const f = fixture('unrelated-speech');
    expect(await models.transcribe(wav(f.name))).toBe('The weather in Paris is lovely this afternoon, so I went for a walk by the river.');
  }, 30_000);

  const ECHO_GAIN = Number(process.env.BARGE_ECHO_GAIN ?? 0.03);
  it("barge-in: English and Turkish stop words over Atlas's own voice wake the pipeline (card #53)", async () => {
    // Atlas speaking, as what is left of it in the microphone after echo cancellation (−30 dB; scripts/barge-bench.mts
    // reports harsher)
    const tts = await models.synthesize('The second card is about the billing export, and the third one is about the onboarding emails.');
    const bed = Float32Array.from({ length: Math.floor((tts.samples.length * SAMPLE_RATE) / tts.sampleRate) }, (_, i) => ECHO_GAIN * tts.samples[Math.floor((i * tts.sampleRate) / SAMPLE_RATE)]!);
    const heard: Record<string, string[]> = {};
    const woke: Record<string, boolean> = {};
    /** End of the stop word (fed in real time) → wake fired, wall clock ms (< 0: before the word had ended). */
    const lat: Record<string, number> = {};
    for (const name of ['barge-stop-en', 'barge-wait-en', 'barge-no-command-en', 'barge-hayir-tr', 'barge-dur-tr', 'barge-bekle-tr', 'barge-sus-tr', 'barge-yeter-tr', 'barge-hayir-command-tr']) {
      const events: VoiceEvent[] = [];
      let wokeAt = 0;
      heard[name] = [];
      const p = new VoicePipeline(models, { onEvent: (e) => (events.push(e), e.type === 'wake' && (wokeAt ||= performance.now())), onHeard: (t) => heard[name]!.push(t) });
      p.setWakeMode('name');
      const voice = wav(name);
      // Atlas alone for 2 s, then both, Atlas stopping 0.8 s after the stop word (≈ when it hears it)
      const lead = 32000;
      const hushAt = lead + fixture(name).speechEnd! + 12800;
      const mic = Float32Array.from({ length: lead + voice.length }, (_, i) => (i < hushAt ? (bed[i] ?? 0) : 0));
      voice.forEach((x, i) => (mic[lead + i]! += x));
      // in real time: the barge-in check runs on the audio as it comes (every ~250 ms, one at a time)
      const t0 = performance.now();
      for (let i = 0; i < mic.length; i += 1600) {
        p.feed(mic.subarray(i, i + 1600));
        await new Promise((r) => setTimeout(r, Math.max(0, (i + 1600) / 16 - (performance.now() - t0))));
      }
      p.feed(new Float32Array(16000)); // silence: the utterance ends
      await p.settled();
      const cmd = events.find((e) => e.type === 'command');
      const wake = events[0];
      if (wake?.type === 'wake') lat[name] = Math.round(wokeAt - t0 - (lead + fixture(name).speechEnd!) / 16);
      woke[name] = wake?.type === 'wake' && (!name.includes('command') || /^(hayır, yarı[nm]|no, i meant tomorrow)/i.test(cmd?.type === 'command' ? cmd.text : ''));
    }
    console.log('barge-in: heard over Atlas speaking', heard, 'end of stop word → wake (ms)', lat);
    // Whisper over the echo is not deterministic from run to run (where the 250 ms checks fall): a short Turkish « sus »
    // or « yeter » is now and then missed (≈ 1 run in 6). One miss of nine is tolerated, never an English one.
    const missed = Object.entries(woke).filter(([, ok]) => !ok).map(([n]) => `${n}: ${heard[n]}`);
    expect(missed.length, missed.join('; ')).toBeLessThanOrEqual(1);
    expect(missed.filter((m) => m.includes('-en:'))).toEqual([]);
    // typical 0.3–0.8 s; when the in-flight checks miss it, the end of the utterance catches it (up to ~2.2 s)
    const ms = Object.values(lat).sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length / 2)]).toBeLessThan(1000);
    for (const x of ms) expect(x).toBeLessThan(4000); // loose: other test files decode in parallel
  }, 120_000);

  it('speaks a reply sentence by sentence as non-empty PCM', async () => {
    const out = [];
    for await (const s of models.speak('Good evening, Master. You have 3 cards in review.')) out.push(s);
    expect(out.map((s) => s.text)).toEqual(['Good evening, Master.', 'You have 3 cards in review.']);
    for (const s of out) {
      expect(s.sampleRate).toBe(44_100);
      expect(s.samples.length).toBeGreaterThan(0.5 * s.sampleRate);
      expect(s.samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0)).toBeGreaterThan(0.05); // not silence
    }
  }, 30_000);

  it('speaks Turkish', async () => {
    const s = await models.synthesize('Merhaba Master, kartı incelemeye aldım.');
    expect(s.samples.length).toBeGreaterThan(1 * s.sampleRate);
    expect(s.samples.reduce((m, x) => Math.max(m, Math.abs(x)), 0)).toBeGreaterThan(0.05);
  }, 30_000);

  it('fires wake while the one-breath sentence is still being said', async () => {
    for (const name of ['wake-daniel-one-breath', 'wake-eddy']) {
      const f = fixture(name);
      const ev = await run([name], undefined, 100); // real time: Whisper decodes in ~0.6 s
      const wake = ev.find((e) => e.type === 'wake');
      expect(wake && wake.type === 'wake' && wake.atSample, name).toBeLessThan(f.speechEnd!);
      expect(ev.filter((e) => e.type === 'command'), name).toHaveLength(1);
    }
  }, 60_000);

  it('measures latency (reported, loosely bounded)', async () => {
    const f = fixture('wake-daniel-one-breath');
    const t: Record<string, number> = {};
    const ev = await run([f.name], undefined, 100); // real time
    const wake = ev.find((e) => e.type === 'wake')!;
    const cmd = ev.find((e) => e.type === 'command')!;
    if (wake.type !== 'wake' || cmd.type !== 'command') throw new Error('no wake/command');
    // audio fed after « Hi Atlas » ended until wake fired (fed in real time, so ≈ wall-clock delay)
    t.wakeAfterWordEndMs = ((wake.atSample - f.wakeEnd!) / SAMPLE_RATE) * 1000;
    t.wakeSttMs = wake.sttMs;
    t.endOfSpeechSilenceMs = ((cmd.endSample - f.speechEnd!) / SAMPLE_RATE) * 1000;
    t.commandSttMs = cmd.sttMs;
    const t0 = performance.now();
    await models.synthesize('Right away, Master.');
    t.textToFirstAudioMs = performance.now() - t0;
    console.log('voice latency (ms)', Object.fromEntries(Object.entries(t).map(([k, v]) => [k, Math.round(v)])));
    expect(t.wakeAfterWordEndMs).toBeLessThan(1500);
    expect(t.wakeSttMs + t.commandSttMs).toBeLessThan(2000);
    expect(t.textToFirstAudioMs).toBeLessThan(3000);
  }, 30_000);
});

it('fixtures are present', () => {
  for (const f of fixtures) expect(existsSync(join(FIXTURES, `${f.name}.wav`)), f.name).toBe(true);
});

describe('voice loop helpers', async () => {
  const { SentenceStream, stripAck, isQuiet } = await import('./loop.ts');
  it('a barge-in made of stop words only is not sent to the chat; anything more is', () => {
    for (const t of ['Stop!', 'stop.', 'Wait a second.', 'No, no.', 'Hayır.', 'Dur, bir dakika.', 'Sus artık!', 'Tamam, yeter.', 'Bekle. Bekle.', 'stop', 'Hold on.', 'Okay, thank you.', 'Душ', 'СУС!', 'Yetersh.'])
      expect(isQuiet(t), t).toBe(true);
    for (const t of ['No, I meant tomorrow.', 'Hayır, yarın için.', 'Wait, what about the login bug?', 'Dur, kartı kapat.', '', '...'])
      expect(isQuiet(t), t).toBe(false);
  });
  it('cuts a streamed reply into sentences as soon as each is complete, never reading code', () => {
    const s = new SentenceStream();
    expect(s.push('Done')).toEqual([]);
    expect(s.push('. I cre')).toEqual(['Done.']); // the next sentence has started: speak the first one now
    expect(s.push('ated card 12. It is assig')).toEqual(['I created card 12.']);
    expect(s.push('ned to atlas.\n```ts\nconst a = 1.')).toEqual(['It is assigned to atlas.']);
    expect(s.push(' B = 2;\n```\nThat is all.')).toEqual([]);
    expect(s.end().join(' ')).toMatch(/That is all\.$/);
    expect(s.end()).toEqual([]);
  });
  it('waits longer after a pause the longer Master has been talking', () => {
    expect(pauseGraceSeconds(1)).toBeCloseTo(0.3);
    expect(pauseGraceSeconds(3)).toBeCloseTo(0.5);
    expect(pauseGraceSeconds(20)).toBe(0.7);
  });

  it("strips Atlas's own « Yes, Master? » heard back from a command", () => {
    expect(stripAck('Yes, Master? Create a card.', 'Master')).toBe('Create a card.');
    expect(stripAck('Yes, Can. What time is it?', 'Can')).toBe('What time is it?');
    expect(stripAck('Yes?', 'the user')).toBe('');
    expect(stripAck('Yesterday was busy.', 'Master')).toBe('Yesterday was busy.');
  });
});
