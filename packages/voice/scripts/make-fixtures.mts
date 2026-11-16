// Builds the WAV test fixtures (16 kHz mono) from macOS `say` voices: a different TTS engine than Kokoro, so the
// tests don't just hear themselves. Run: npx tsx packages/voice/scripts/make-fixtures.mts (macOS only).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';

const SR = 16000;
const out = join(import.meta.dirname, '../test/fixtures');
const tmp = mkdtempSync(join(tmpdir(), 'voice-fx-'));
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

function say(voice: string, text: string): Float32Array {
  const f = join(tmp, `${Math.random()}.wav`);
  execFileSync('say', ['-v', voice, text, '-o', f, '--data-format=LEI16@16000']);
  const s = sherpa.readWave(f, false).samples;
  // trim leading/trailing silence so the fixture timings below are exact
  let a = 0, b = s.length;
  while (a < b && Math.abs(s[a]!) < 0.01) a++;
  while (b > a && Math.abs(s[b - 1]!) < 0.01) b--;
  return s.slice(a, b);
}
const TR = 'Yelda (Turkish (Türkiye))';
const noise = (sec: number) => Float32Array.from({ length: Math.round(sec * SR) }, () => rand() * 0.003);

function build(name: string, parts: (Float32Array | number)[], marks: Record<string, number> = {}) {
  const arrs = parts.map((p) => (typeof p === 'number' ? noise(p) : p));
  const all = new Float32Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  const ends: number[] = [];
  for (const a of arrs) { all.set(a, o); o += a.length; ends.push(o); }
  for (const a of arrs.keys()) if (typeof parts[a] !== 'number') all.subarray(ends[a]! - arrs[a]!.length, ends[a]).forEach((v, i, arr) => (arr[i] = v + rand() * 0.003));
  sherpa.writeWave(join(out, `${name}.wav`), { samples: all, sampleRate: SR });
  const m: Record<string, number> = {};
  for (const [k, idx] of Object.entries(marks)) m[k] = ends[idx]!;
  return { name, samples: all.length, ...m };
}

const meta = [
  // wakeEnd: sample where "Hi Atlas" ends; speechEnd: where the command ends
  build('wake-daniel-one-breath', [0.6, say('Daniel', 'Hi Atlas'), 0.15, say('Daniel', 'What is on the board today?'), 2], { wakeEnd: 1, speechEnd: 3 }),
  build('wake-samantha-pause', [0.6, say('Samantha', 'Hi Atlas'), 1.2, say('Samantha', 'Create a card to fix the login bug.'), 2], { wakeEnd: 1, speechEnd: 3 }),
  build('wake-eddy', [0.6, say('Eddy (English (US))', 'Hi Atlas'), 0.3, say('Eddy (English (US))', 'What time is it in Tokyo?'), 2], { wakeEnd: 1, speechEnd: 3 }),
  build('silence', [5]),
  build('unrelated-speech', [0.5, say('Daniel', 'The weather in Paris is lovely this afternoon, so I went for a walk by the river.'), 1]),
  build('near-miss-atlas', [0.5, say('Samantha', 'I bought a new atlas of the world at the bookshop, and a map of Italy.'), 1]),
  // voice loop (card #38): a follow-up without the wake word, and a barge-in on the name alone
  build('follow-up', [0.5, say('Samantha', 'And what about tomorrow?'), 1.5], { speechEnd: 1 }),
  build('barge-atlas', [0.4, say('Samantha', 'Atlas, stop.'), 1.5], { speechEnd: 1 }),
  // card #40: a breath mid-sentence (1 s) must not end the command; pauseAt = where the first part ends
  build('follow-up-pause', [0.5, say('Samantha', 'Create a card to fix the login bug'), 1.0, say('Samantha', 'and assign it to me.'), 2], { pauseAt: 1, speechEnd: 3 }),
  build('wake-pause-mid-command', [0.6, say('Daniel', 'Hi Atlas'), 0.15, say('Daniel', 'What is on the board'), 1.0, say('Daniel', 'and what is blocked?'), 2], { wakeEnd: 1, pauseAt: 3, speechEnd: 5 }),
  // card #53: barge-in stop words while Atlas speaks, English and Turkish (Yelda = macOS's Turkish voice)
  build('barge-stop-en', [0.4, say('Samantha', 'Stop.'), 1.5], { speechEnd: 1 }),
  build('barge-wait-en', [0.4, say('Daniel', 'Wait.'), 1.5], { speechEnd: 1 }),
  build('barge-no-command-en', [0.4, say('Samantha', 'No, I meant tomorrow.'), 1.5], { speechEnd: 1 }),
  build('barge-hayir-tr', [0.4, say(TR, 'Hayır.'), 1.5], { speechEnd: 1 }),
  build('barge-dur-tr', [0.4, say(TR, 'Dur.'), 1.5], { speechEnd: 1 }),
  build('barge-bekle-tr', [0.4, say(TR, 'Bekle.'), 1.5], { speechEnd: 1 }),
  build('barge-sus-tr', [0.4, say(TR, 'Sus.'), 1.5], { speechEnd: 1 }),
  build('barge-yeter-tr', [0.4, say(TR, 'Yeter.'), 1.5], { speechEnd: 1 }),
  build('barge-hayir-command-tr', [0.4, say(TR, 'Hayır, yarın için bir kart aç.'), 1.5], { speechEnd: 1 }),
];
writeFileSync(join(out, 'fixtures.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(meta);
