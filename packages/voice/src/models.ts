import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

/**
 * The three voice models, all from the sherpa-onnx GitHub releases. Each one lives in its own folder under the models
 * dir (`<models>/<id>/`), with a `.verified` marker written only after the download matched its sha256 and was unpacked.
 */
export interface ModelSpec {
  id: string;
  url: string;
  sha256: string;
  /** 'tar.bz2': unpacked into the folder (top-level directory stripped); 'file': saved as-is under `fileName`. */
  kind: 'tar.bz2' | 'file';
  fileName?: string;
  /** Files (relative to the model folder) that must exist for the model to load. */
  files: string[];
  /** Approximate download size, for the UI. */
  bytes: number;
}

const REL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export const MODELS = {
  vad: {
    id: 'vad',
    url: `${REL}/asr-models/silero_vad.onnx`,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    kind: 'file',
    fileName: 'silero_vad.onnx',
    files: ['silero_vad.onnx'],
    bytes: 643_854,
  },
  // Whisper large-v3-turbo (card #42): English and Turkish
  stt: {
    id: 'stt',
    url: `${REL}/asr-models/sherpa-onnx-whisper-turbo.tar.bz2`,
    sha256: 'b11acbbcd660b44a8e0df33724feb5aaa709cf65668f2823d59f656312544f22',
    kind: 'tar.bz2',
    files: ['turbo-encoder.int8.onnx', 'turbo-decoder.int8.onnx', 'turbo-tokens.txt'],
    bytes: 563_790_207,
  },
  // Supertonic 3 (card #42): one model for English and Turkish, 10 voices, 44.1 kHz
  tts: {
    id: 'tts',
    url: `${REL}/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2`,
    sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
    kind: 'tar.bz2',
    files: ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin'],
    bytes: 128_774_318,
  },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

const MARKER = '.verified';

/** Where models live by default: next to the Atlas data, in the app data dir (macOS: ~/Library/Application Support/Atlas). */
export function defaultModelsDir(): string {
  return process.env.ATLAS_VOICE_MODELS ?? join(homedir(), 'Library', 'Application Support', 'Atlas', 'voice-models');
}

export function modelDir(modelsDir: string, spec: ModelSpec): string {
  return join(modelsDir, spec.id);
}

export function isInstalled(modelsDir: string, spec: ModelSpec): boolean {
  const dir = modelDir(modelsDir, spec);
  return existsSync(join(dir, MARKER)) && readFileSync(join(dir, MARKER), 'utf8').trim() === spec.sha256 && spec.files.every((f) => existsSync(join(dir, f)));
}

export function missingModels(modelsDir: string): ModelId[] {
  return MODEL_IDS.filter((id) => !isInstalled(modelsDir, MODELS[id]));
}

export class VoiceModelError extends Error {
  override name = 'VoiceModelError';
}

/** Throws a clear error naming every missing model (CLAUDE.md rule 3: no silent fallback). */
export function assertInstalled(modelsDir: string, ids: readonly ModelId[] = MODEL_IDS): void {
  const missing = ids.filter((id) => !isInstalled(modelsDir, MODELS[id]));
  if (missing.length)
    throw new VoiceModelError(`voice models missing in ${modelsDir}: ${missing.join(', ')}. Download them first (fetchModel).`);
}

export interface FetchProgress {
  id: string;
  received: number;
  total: number | undefined;
}

/**
 * Downloads a model, checks its sha256, unpacks it, then marks it verified. Atomic: everything goes to a temp path
 * first and the model folder is swapped in only when complete, so a crash mid-download leaves no half model.
 * Resumable: an interrupted download (abort, network error, crash) keeps its `.download` file, and the next call asks
 * the server for the rest (HTTP Range) instead of starting over. A sha mismatch throws and keeps nothing.
 */
export async function fetchModel(modelsDir: string, spec: ModelSpec, onProgress?: (p: FetchProgress) => void, signal?: AbortSignal): Promise<void> {
  if (isInstalled(modelsDir, spec)) return;
  mkdirSync(modelsDir, { recursive: true });
  const part = join(modelsDir, `.${spec.id}.download`);
  const tmpDir = join(modelsDir, `.${spec.id}.tmp`);
  rmSync(tmpDir, { recursive: true, force: true });
  let keepPart = true;
  try {
    const have = existsSync(part) ? statSync(part).size : 0;
    const res = await fetch(spec.url, { redirect: 'follow', signal, headers: have ? { range: `bytes=${have}-` } : {} });
    // 416: the part already holds the whole file (stopped between download and unpack)
    const complete = have > 0 && res.status === 416;
    if (!complete && (!res.ok || !res.body)) throw new VoiceModelError(`download of voice model ${spec.id} failed: HTTP ${res.status} ${spec.url}`);
    const resumed = res.status === 206 || complete;
    if (complete) await res.body?.cancel();
    const hash = createHash('sha256');
    // resuming: the bytes already on disk go into the checksum first
    if (resumed) for await (const chunk of createReadStream(part)) hash.update(chunk as Buffer);
    let received = resumed ? have : 0;
    const length = Number(res.headers.get('content-length')) || 0;
    const total = complete ? have : length ? received + length : undefined;
    onProgress?.({ id: spec.id, received, total });
    if (!complete) {
      const meter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          received += chunk.length;
          onProgress?.({ id: spec.id, received, total });
          done(null, chunk);
        },
      });
      // cast: lib.dom's and node's ReadableStream types disagree; the runtime object is the same
      await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), meter, createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal });
    }
    // past this point a failure starts over: the bytes are complete, or wrong
    keepPart = false;
    const sha = hash.digest('hex');
    if (sha !== spec.sha256) throw new VoiceModelError(`voice model ${spec.id}: sha256 mismatch (got ${sha}, expected ${spec.sha256})`);

    mkdirSync(tmpDir, { recursive: true });
    if (spec.kind === 'file') renameSync(part, join(tmpDir, spec.fileName ?? spec.id));
    else await promisify(execFile)('tar', ['-xjf', part, '-C', tmpDir, '--strip-components', '1']);
    const missing = spec.files.filter((f) => !existsSync(join(tmpDir, f)));
    if (missing.length) throw new VoiceModelError(`voice model ${spec.id}: archive lacks ${missing.join(', ')}`);
    writeFileSync(join(tmpDir, MARKER), spec.sha256 + '\n');

    const dir = modelDir(modelsDir, spec);
    rmSync(dir, { recursive: true, force: true });
    renameSync(tmpDir, dir);
  } finally {
    if (!keepPart) rmSync(part, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
