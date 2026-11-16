import { join } from 'node:path';
import sherpa from 'sherpa-onnx-node';
import type { OfflineRecognizer, OfflineTts } from 'sherpa-onnx-node';
import { MODELS, VoiceModelError, assertInstalled, modelDir, type ModelId } from './models.ts';

/** Languages Master speaks (Whisper's codes): anything else detected is decoded again as English. */
const STT_LANGS = ['en', 'tr'];
/** Silence added before and after an utterance for Whisper (0.3 s). */
const PAD_SAMPLES = 4_800;

/** Whisper large-v3-turbo; language '' = detect. */
function whisperConfig(file: (f: string) => string, language: string, numThreads: number): object {
  return {
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      whisper: { encoder: file('turbo-encoder.int8.onnx'), decoder: file('turbo-decoder.int8.onnx'), language, task: 'transcribe' },
      tokens: file('turbo-tokens.txt'),
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
  };
}

/** Every input frame is mono float PCM in [-1, 1] at this rate. */
export const SAMPLE_RATE = 16_000;

/**
 * Supertonic 3 voices (speaker ids 0–9). Default: voice 9, Master's pick by ear on pages/voice-models.html (card #42,
 * docs/voice-models.md).
 */
export const VOICES = { 'voice-9': 9, 'voice-0': 0, 'voice-1': 1, 'voice-2': 2, 'voice-3': 3, 'voice-4': 4, 'voice-5': 5, 'voice-6': 6, 'voice-7': 7, 'voice-8': 8 } as const;
export type VoiceName = keyof typeof VOICES;
export const DEFAULT_VOICE: VoiceName = 'voice-9';
/** Speaking rate and diffusion steps, as on the listening page Master chose from. */
const SPEED = 1.05;
const STEPS = 8;

/**
 * The language a reply sentence is spoken in: Turkish when it has Turkish-only letters (ğ ı İ ş) or Turkish words,
 * English otherwise. Supertonic reads the English words in a Turkish sentence acceptably (« merge ettim »).
 */
export function speechLang(sentence: string): 'en' | 'tr' {
  if (/[ğĞıİşŞ]/.test(sentence)) return 'tr';
  const words = sentence.toLocaleLowerCase('tr').match(/\p{L}+/gu) ?? [];
  const tr = words.filter((w) => TR_WORDS.has(w)).length;
  return tr >= 2 || (tr >= 1 && /[çÇöÖüÜ]/.test(sentence)) ? 'tr' : 'en';
}
const TR_WORDS = new Set(['ve', 'bir', 'bu', 'şu', 'için', 'ile', 'de', 'da', 'mi', 'mı', 'mu', 'mü', 'ne', 'var', 'yok', 'evet', 'hayır', 'tamam', 'ben', 'sen', 'biz', 'siz', 'çok', 'daha', 'gibi', 'ama', 'kart', 'kartı', 'merhaba', 'nasıl', 'şimdi', 'sonra', 'oldu', 'olarak', 'değil', 'her', 'hiç', 'iyi', 'teşekkürler', 'saat', 'yüzde']);

export interface LoadOptions {
  /** Which models to load (all by default). A pipeline needs vad and stt; speaking needs tts. */
  only?: readonly ModelId[];
  numThreads?: number;
}

interface Loaded {
  stt?: OfflineRecognizer;
  tts?: OfflineTts;
  sttConfig?: (language: string) => object;
  vadModel?: string;
}

/**
 * The loaded models. Load once (a few seconds: Whisper is big), then create pipelines and speak with it.
 * Loading fails loudly with a VoiceModelError when a model is missing or does not load: no fallback to `say`.
 */
export class VoiceModels {
  /** Whisper decodes one at a time: the language fallback swaps the recognizer's config. */
  private sttQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly dir: string,
    private readonly loaded: Loaded,
  ) {}

  static async load(modelsDir: string, opts: LoadOptions = {}): Promise<VoiceModels> {
    const ids = opts.only ?? (['vad', 'stt', 'tts'] as const);
    assertInstalled(modelsDir, ids);
    const threads = opts.numThreads ?? 4;
    const p = (id: ModelId, file: string) => join(modelDir(modelsDir, MODELS[id]), file);
    const step = async <T>(id: ModelId, fn: () => T | Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        throw new VoiceModelError(`voice model ${id} failed to load from ${modelDir(modelsDir, MODELS[id])}: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    const loaded: Loaded = {};
    if (ids.includes('vad')) loaded.vadModel = p('vad', 'silero_vad.onnx');
    if (ids.includes('stt'))
      loaded.stt = await step('stt', () =>
        sherpa.OfflineRecognizer.createAsync(whisperConfig((f) => p('stt', f), '', threads)),
      );
    if (ids.includes('stt')) loaded.sttConfig = (language: string) => whisperConfig((f) => p('stt', f), language, threads);
    if (ids.includes('tts'))
      loaded.tts = await step('tts', () =>
        sherpa.OfflineTts.createAsync({
          model: {
            supertonic: {
              durationPredictor: p('tts', 'duration_predictor.int8.onnx'),
              textEncoder: p('tts', 'text_encoder.int8.onnx'),
              vectorEstimator: p('tts', 'vector_estimator.int8.onnx'),
              vocoder: p('tts', 'vocoder.int8.onnx'),
              ttsJson: p('tts', 'tts.json'),
              unicodeIndexer: p('tts', 'unicode_indexer.bin'),
              voiceStyle: p('tts', 'voice.bin'),
            },
            numThreads: threads,
            provider: 'cpu',
            debug: 0,
          },
          maxNumSentences: 1,
        }),
      );
    return new VoiceModels(modelsDir, loaded);
  }

  private need<K extends keyof Loaded>(key: K, id: ModelId): NonNullable<Loaded[K]> {
    const m = this.loaded[key];
    if (!m) throw new VoiceModelError(`voice model ${id} was not loaded (VoiceModels.load only: […])`);
    return m;
  }

  get vadModel(): string {
    return this.need('vadModel', 'vad');
  }

  /**
   * Speech to text for one utterance (16 kHz mono), English or Turkish. Whisper detects the language; on short English
   * takes it sometimes picks another one (« Hey, mach was. » as German), so anything but en/tr is decoded again as
   * English. Calls run one at a time, off the main thread.
   * `language`: decode in that language only, no detection (the barge-in check, see VoicePipeline.earlyCheck).
   */
  transcribe(samples: Float32Array, language?: 'en' | 'tr'): Promise<string> {
    const run = this.sttQueue.then(() => (language ? this.decodeIn(samples, language) : this.decode(samples)));
    this.sttQueue = run.catch(() => undefined);
    return run;
  }

  private decodeOnce(samples: Float32Array) {
    const stt = this.need('stt', 'stt');
    // silence around the speech: the VAD cuts tight, and Whisper drops a clipped last word (« Create a car »)
    const padded = new Float32Array(samples.length + PAD_SAMPLES * 2);
    padded.set(samples, PAD_SAMPLES);
    const stream = stt.createStream();
    stream.acceptWaveform({ samples: padded, sampleRate: SAMPLE_RATE });
    return stt.decodeAsync(stream);
  }

  private async decode(samples: Float32Array): Promise<string> {
    const res = await this.decodeOnce(samples);
    if (!res.text.trim() || STT_LANGS.includes(res.lang ?? '')) return res.text.trim();
    return this.decodeIn(samples, 'en');
  }

  private async decodeIn(samples: Float32Array, language: 'en' | 'tr'): Promise<string> {
    const stt = this.need('stt', 'stt');
    const config = this.need('sttConfig', 'stt');
    stt.setConfig(config(language));
    try {
      return (await this.decodeOnce(samples)).text.trim();
    } finally {
      stt.setConfig(config(''));
    }
  }

  /**
   * Text to speech for one sentence, in English or Turkish (speechLang). Supertonic outputs 44.1 kHz mono float PCM and
   * reads numbers, times and symbols itself. Runs off the main thread.
   */
  async synthesize(text: string, voice: VoiceName = DEFAULT_VOICE, speed = SPEED): Promise<{ samples: Float32Array; sampleRate: number }> {
    const tts = this.need('tts', 'tts');
    const generationConfig = new sherpa.GenerationConfig({ sid: VOICES[voice], speed, numSteps: STEPS, extra: { lang: speechLang(text) } });
    const audio = await tts.generateAsync({ text, generationConfig, enableExternalBuffer: false });
    if (!audio.samples.length) throw new Error(`text to speech produced no audio for: ${JSON.stringify(text)}`);
    return { samples: audio.samples, sampleRate: audio.sampleRate };
  }

  /**
   * Speaks a reply sentence by sentence: yields each sentence's PCM as soon as it is synthesized, so playback can
   * start after the first sentence instead of the whole reply.
   */
  async *speak(text: string, voice: VoiceName = DEFAULT_VOICE, speed = SPEED): AsyncGenerator<{ text: string; samples: Float32Array; sampleRate: number }> {
    for (const sentence of splitSentences(text)) yield { text: sentence, ...(await this.synthesize(sentence, voice, speed)) };
  }
}

/** Splits text into sentences for TTS: on . ! ? … before a capital or digit, and on line breaks. Markdown symbols are dropped. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#+\s/gm, '')
    .replace(/[*_`>|]+/g, ' ')
    // a new sentence starts with a capital or a digit: « 2:14 a.m. and » is not cut
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}\d"'(])|\n+/u)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s));
}

/**
 * The wake phrase: « hi / hey / hello Atlas » within the first words of a sentence (Parakeet writes it « Hi Atlas »,
 * « Hey, Atlas. », sometimes « I Atlas. » when the h is soft,
 * and « Atlas » itself as « Aglas », « Adlas », « Atlus », « at last »). A sentence, not the utterance: with no pause after
 * other talk, « …by the river. Hi Atlas, create a card » is one utterance. A bare « atlas » mid-sentence
 * (« a new atlas of the world ») is not a wake.
 * Whisper's spellings on Master's takes (card #42): « Hey, atas! », « Hey, Attas », « Hey, atrás », « Her atlas »,
 * « Hej », « Hayatlas » (glued), and « Atlas » alone as the whole utterance.
 */
const WAKE =
  /(?:^|[.!?]\s+)\W*(?:(?:[\p{L}']+\W+){0,2}?(?:hi|hey|hiya|hello|high|hai|i|ai|okay|ok|her|hay|ay|hej|eh|ei)\W+a(?:[tdgk] ?l|tt?|tr)[aeiouá]s{1,2}t?\b|h[ae][yi]atlas\b|atlas\W*$)[\s,.!?;:-]*/iu;
/** Barge-in: the name alone, anywhere (« Atlas, stop », « okay Atlas »), with the usual mishearings of it. */
const NAME = /\b(?:atlas|atlus|adlas|aglas|atlass|attas)\b[\s,.!?;:-]*/iu;

/** Barge-in (Atlas is speaking): what follows the name « Atlas » in the transcript (maybe ''), or undefined if not said. */
export function afterName(text: string): string | undefined {
  const m = NAME.exec(text);
  return m ? text.slice(m.index + m[0].length).trim() : undefined;
}

/**
 * Barge-in stop words (card #53), English and Turkish, with Whisper's spellings of them on short takes: « dur » comes
 * out « Duş », « Düş » or Cyrillic « Душ » (detected as Russian), « sus » as « СУС », « TUS » or, over Atlas's echo, « Slus »,
 * « hayır » forced to English as « No. », « yeter » as « Yetersh », « Yetash », « Yetş »;
 * over the echo, « hayır » decoded as Turkish comes out « Hayyuz », « Hayüz », « Hayush », « Hayırs ». Keyed by the word, for the echo check (is Atlas saying it itself?).
 */
const STOP_WORDS: Record<string, string> = {
  stop: 'stop+|stahp',
  wait: 'wait',
  no: 'no+|nope',
  dur: 'dur+|du[şs]h?|düş|dusch|дур|душ',
  hayır: 'hay+[ıiuüy]*[rszş]+h?|ha[iy]ir',
  bekle: 'bekle',
  sus: '[st]us+|s?lu[sz]h?|сус',
  yeter: 'yeter+|yet[aeş]s?h?|yetersh',
};
const L = '(?<![\\p{L}\\p{N}])';
const R = '(?![\\p{L}\\p{N}])';
const NL = '[^\\p{L}\\p{N}]';
/**
 * A stop word opening a sentence (« Stop! », « Hayır, yarın için », « Okay, wait », « …the onboarding emails. Stop! »
 * when the transcript also caught Atlas's own voice): only there, not mid-sentence (« you'll have to wait »).
 */
const STOP_AT = new RegExp(`(?:^|[.!?…]\\s+)${NL}*(?:(?:oh|okay|ok|hey)${NL}+)?(${Object.values(STOP_WORDS).join('|')})${R}`, 'giu');

/**
 * The last stop word opening a sentence in `text` (the most recent: what Master said over Atlas's echo): its key in
 * STOP_WORDS and where its sentence starts. Undefined when there is none.
 */
export function stopWord(text: string): { word: string; at: number } | undefined {
  let last: RegExpExecArray | undefined;
  for (const m of text.matchAll(STOP_AT)) last = m;
  if (!last) return undefined;
  const said = last[1]!;
  const word = Object.keys(STOP_WORDS).find((k) => new RegExp(`^(?:${STOP_WORDS[k]})$`, 'iu').test(said))!;
  const at = last.index + (/^[.!?…]\s+/u.exec(last[0])?.[0].length ?? 0);
  return { word, at };
}

/** Whether `sentence` (something Atlas says) contains the stop word `word` anywhere: hearing it then may be an echo. */
export function saysStopWord(sentence: string, word: string): boolean {
  const alt = STOP_WORDS[word];
  return !!alt && new RegExp(`${L}(?:${alt})${R}`, 'iu').test(sentence);
}

/**
 * Barge-in (Atlas is speaking or thinking): « Atlas » anywhere → what follows it; a stop word opening a sentence →
 * that sentence and what follows (« No, I meant tomorrow » is the new message as said); undefined when neither.
 */
export function afterBargeIn(text: string): string | undefined {
  const name = afterName(text);
  if (name !== undefined) return name;
  const stop = stopWord(text);
  return stop ? text.slice(stop.at).trim() : undefined;
}

/** Low sensitivity: only the phrase as written, « hi / hey / hello Atlas », at the start of a sentence. */
const WAKE_STRICT = /(?:^|[.!?]\s+)\W*(?:hi|hey|hello)\W+atlas\b[\s,.!?;:-]*/iu;

/**
 * If the transcript holds the wake phrase: what follows it (maybe ''), anything before is dropped; otherwise undefined.
 * `strict`: the exact phrase only, none of the mishearings (fewer false wakes, more missed ones).
 */
export function afterWakePhrase(text: string, strict = false): string | undefined {
  const m = (strict ? WAKE_STRICT : WAKE).exec(text);
  return m ? text.slice(m.index + m[0].length).trim() : undefined;
}

/**
 * Wake word sensitivity (Settings → Voice, 0 = low … 1 = high, default 0.5) as pipeline settings: the speech detector's
 * threshold (higher sensitivity: quieter or farther speech counts as speech) and, below a third, the strict wake phrase.
 */
export function sensitivitySettings(sensitivity: number): { vadThreshold: number; strictWake: boolean } {
  const s = Math.min(1, Math.max(0, sensitivity));
  return { vadThreshold: Math.round((0.7 - 0.4 * s) * 100) / 100, strictWake: s < 1 / 3 };
}
