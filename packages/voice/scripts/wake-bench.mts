/**
 * Wake phrase hit rate: synthesizes many ways of saying « Hey Atlas » (macOS voices × speaking rates × phrasings) and
 * near-miss sentences that must NOT wake, transcribes each with the installed Parakeet model, and counts wakes.
 * Also replays transcripts of Master's real tries (from logs/voice.log in debug mode) through the text matcher.
 *
 *   node packages/voice/scripts/wake-bench.mts [--models DIR] [--json out.json]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceModels, afterWakePhrase, SAMPLE_RATE } from '../src/engine.ts';

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const modelsDir = arg('--models') ?? join(homedir(), 'Library/Application Support/Atlas/voice-models');

const VOICES = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Rishi', 'Tessa', 'Fred', 'Eddy (English (US))', 'Flo (English (US))', 'Reed (English (US))', 'Sandy (English (US))', 'Shelley (English (US))'];
const RATES = [150, 200, 260, 330];
const WAKES = ['Hey Atlas', 'Hi Atlas', 'Hey Atlas, what time is it?', 'Hello Atlas', 'Okay Atlas', 'Hey, Atlas', 'Heyatlas'];
const NEAR = [
  'Hey, at that point we stopped.',
  'I bought an atlas of the world.',
  'Yeah, that is fine.',
  'Hey, up there!',
  'At last, we are done.',
  'Hey, how are you?',
  'Hi, I am at the office.',
  'Hey, I guess so.',
];
/** Master's real tries (13 Nov 2026, built-in mic): what Parakeet wrote. wake = it was « Hey Atlas ». */
const REAL: [string, boolean][] = [
  ['Hey, but this.', true],
  ['Hey, up there.', true],
  ['Hey, I guess.', true],
  ['Hey, at that.', true],
  ['Yeah, that\'s.', true],
  ['Uh yeah, that\'s how yeah.', true],
  ['Yeah.', false],
  ['What time is it?', false],
  ['Right and left.', false],
  ['Okay.', false],
  ['Two cards are running and one is waiting on you. The orb overlay is built and being measured.', false],
];

function wav(text: string, voice: string, rate: number, dir: string, n: number): Float32Array {
  const f = join(dir, `${n}.wav`);
  execFileSync('say', ['-v', voice, '-r', String(rate), '-o', f, `--data-format=LEI16@${SAMPLE_RATE}`, text]);
  const b = readFileSync(f);
  const data = b.indexOf('data') + 8;
  const pcm = new Int16Array(b.buffer.slice(b.byteOffset + data, b.byteOffset + b.length));
  const out = new Float32Array(pcm.length + SAMPLE_RATE / 2); // a little silence before and after, like the VAD's cut
  for (let i = 0; i < pcm.length; i++) out[SAMPLE_RATE / 4 + i] = pcm[i]! / 32768;
  return out;
}

const models = await VoiceModels.load(modelsDir, { only: ['stt'] });
const dir = mkdtempSync(join(tmpdir(), 'wake-bench-'));
let n = 0;
const rows: { text: string; voice: string; rate: number; heard: string; woke: boolean; want: boolean }[] = [];
for (const voice of VOICES)
  for (const rate of RATES)
    for (const [list, want] of [[WAKES, true], [NEAR, false]] as const)
      for (const text of list) {
        const heard = await models.transcribe(wav(text, voice, rate, dir, n++));
        rows.push({ text, voice, rate, heard, woke: afterWakePhrase(heard) !== undefined, want });
      }

const rate = (r: typeof rows) => `${r.filter((x) => x.woke).length}/${r.length} (${Math.round((100 * r.filter((x) => x.woke).length) / r.length)} %)`;
const wakes = rows.filter((r) => r.want);
const near = rows.filter((r) => !r.want);
console.log(`synthesized wakes that woke:     ${rate(wakes)}`);
for (const rt of RATES) console.log(`  at ${rt} wpm: ${rate(wakes.filter((r) => r.rate === rt))}`);
for (const t of WAKES) console.log(`  « ${t} »: ${rate(wakes.filter((r) => r.text === t))}`);
console.log(`near misses that woke (false):   ${rate(near)}`);
for (const r of near.filter((x) => x.woke)) console.log(`  FALSE ${r.voice} ${r.rate}: « ${r.text} » heard « ${r.heard} »`);
const missed = new Map<string, number>();
for (const r of wakes.filter((x) => !x.woke)) missed.set(r.heard, (missed.get(r.heard) ?? 0) + 1);
console.log('most common transcripts of missed wakes:');
for (const [h, c] of [...missed].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${c}× « ${h} »`);
const realOk = REAL.filter(([t, want]) => (afterWakePhrase(t) !== undefined) === want).length;
console.log(`Master's real transcripts classified right: ${realOk}/${REAL.length}`);
for (const [t, want] of REAL) if ((afterWakePhrase(t) !== undefined) !== want) console.log(`  WRONG (${want ? 'missed' : 'false wake'}): « ${t} »`);
const out = arg('--json');
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
