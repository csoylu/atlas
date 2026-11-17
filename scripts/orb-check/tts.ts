// Synthesizes the check's reply with the real Kokoro voice (Node, not Electron: sherpa-onnx's addon is built for Node).
// Usage: npx tsx scripts/orb-check/tts.ts <modelsDir> <outDir>
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VoiceModels } from '@atlas/voice';

const [modelsDir, out] = process.argv.slice(2);
if (!modelsDir || !out) throw new Error('usage: tts.ts <modelsDir> <outDir>');
const models = await VoiceModels.load(modelsDir, { only: ['tts'] });
const reply = 'Two cards are running, and one is waiting on you. The orb overlay is built and being measured. Everything stays on this Mac.';
const sentences: { text: string; file: string; sampleRate: number; seconds: number }[] = [];
let i = 0;
for await (const s of models.speak(reply)) {
  const file = join(out, `reply-${i++}.f32`);
  writeFileSync(file, Buffer.from(s.samples.buffer, s.samples.byteOffset, s.samples.byteLength));
  sentences.push({ text: s.text, file, sampleRate: s.sampleRate, seconds: s.samples.length / s.sampleRate });
}
writeFileSync(join(out, 'reply.json'), JSON.stringify(sentences, null, 2));
console.log(`tts: ${sentences.length} sentences, ${sentences.reduce((n, s) => n + s.seconds, 0).toFixed(1)} s`);
