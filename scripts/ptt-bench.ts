// Card #57: CPU of the desktop voice loop at rest while a « video » talks near the Mac, wake word on vs off.
// Real models, real engine (fake provider), DesktopVoice fed 100 ms frames of speech in real time (as the orb page does).
// Run: npx tsx scripts/ptt-bench.ts $TMPDIR/video16k.wav [seconds]
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { startEngine } from '@atlas/engine';
import { VoiceModels, defaultModelsDir } from '@atlas/voice';
import { FakeProvider } from '../packages/engine/src/providers/fake.ts';
import { DesktopVoice } from '../apps/desktop/src/voice.ts';

const [file, secs = '60'] = process.argv.slice(2);
const speech = sherpa.readWave(file!, false).samples;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(wakeWord: boolean) {
  const dataDir = mkdtempSync(join(tmpdir(), 'ptt-bench-'));
  mkdirSync(join(dataDir, 'workspaces', 'atlas'), { recursive: true });
  const engine = await startEngine({
    dbFile: ':memory:', dataDir, port: 0, providers: () => new FakeProvider([]), env: {}, manageLocal: false,
    voice: { modelsDir: defaultModelsDir(), micAccess: () => 'granted', requestMicAccess: async () => true },
  });
  await engine.voice!.update({ enabled: true, wakeWord });
  let stt = 0;
  const orig = VoiceModels.prototype.transcribe;
  VoiceModels.prototype.transcribe = function (...a) {
    stt++;
    return orig.apply(this, a);
  };
  const noop = () => {};
  const orb = { setState: noop, transcript: noop, speak: async () => true, hush: noop, error: noop, dismiss: noop, rawMic: noop, mic: noop };
  const talk = new DesktopVoice(engine, orb as never, join(dataDir, 'voice.log'), noop, { register: () => true, unregister: noop });
  talk.sync();
  while (!talk.running) await sleep(50);
  await sleep(1000);
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const n = Number(secs) * 10;
  for (let k = 0; k < n; k++) {
    const i = (k * 1600) % (speech.length - 1600);
    talk.feed(speech.subarray(i, i + 1600));
    await sleep(Math.max(0, (k + 1) * 100 - (performance.now() - t0)));
  }
  await sleep(500);
  const c = process.cpuUsage(c0);
  const wall = (performance.now() - t0) / 1000;
  console.log(`wake word ${wakeWord ? 'ON ' : 'OFF'}: ${(((c.user + c.system) / 1e6 / wall) * 100).toFixed(1)}% of a core over ${wall.toFixed(0)} s, ${stt} Whisper runs`);
  VoiceModels.prototype.transcribe = orig;
  talk.stop();
  await engine.stop();
}

await run(true);
await run(false);
process.exit(0);
