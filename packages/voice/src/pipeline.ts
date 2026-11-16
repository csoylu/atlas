import sherpa from 'sherpa-onnx-node';
import type { Vad } from 'sherpa-onnx-node';
import { SAMPLE_RATE, afterBargeIn, afterWakePhrase, sensitivitySettings, type VoiceModels } from './engine.ts';

export type VoiceEvent =
  /** « Hi Atlas » was heard. `atSample`: how much audio had been fed when it was recognised (usually mid-utterance). */
  | { type: 'wake'; atSample: number; sttMs: number; text: string }
  /** The wake utterance has ended with nothing after « Hi Atlas »: now waiting for the command (time to answer). */
  | { type: 'awaiting'; sttMs: number }
  /**
   * A command (wake phrase removed). `endSample`: where it was sent to speech-to-text in the fed audio. `tailMs`: the
   * silence waited after the speech before sending it (silenceSeconds + the pause grace).
   */
  | { type: 'command'; text: string; raw: string; endSample: number; sttMs: number; tailMs: number }
  /** Woken (or startCapture) but no command started within the timeout. Back to listening. */
  | { type: 'timeout' }
  | { type: 'error'; error: Error };

/** The early wake check looks at an utterance's first seconds, this often. */
const EARLY_SECONDS = 3;
const EARLY_EVERY = 0.25;
/**
 * Barge-in mode looks at the last this-many seconds: a stop word (~0.4 s) is whole in two checks or more (Whisper takes
 * ~0.5 s each), with little of Atlas's echo around it to drown it.
 */
const BARGE_SECONDS = 1.5;
/**
 * Shortest speech the detector reports: a curt « dur » or « sus » lasts ~0.35 s, and silero only counts ~0.2 s of it.
 * Outside barge-in, anything under WAKE_MIN_SPEECH is dropped as before (a cough, a click): no wake phrase is that short.
 */
const MIN_SPEECH_SECONDS = 0.1;
/** Push-to-talk held (card #75): audio past this is not kept (Whisper takes 30 s at most). */
const HOLD_MAX_SECONDS = 30;
const WAKE_MIN_SPEECH = 0.25;

/**
 * Pause grace for commands (card #40): a breath mid-sentence must not end Master's message. A command utterance cut
 * by the VAD (silenceSeconds) is held a little longer; if speech resumes meanwhile, the next part is appended. The
 * extra wait grows with how long Master has been talking: 1 s of speech → +0.3 s, 3 s → +0.5 s, 5 s and more → +0.7 s
 * (so 0.8 s of silence ends a short reply, 1.5 s a long one). Not for a bare « Hi Atlas » (it would delay the answer).
 */
export function pauseGraceSeconds(speechSeconds: number): number {
  return Math.min(0.7, 0.2 + 0.1 * speechSeconds);
}
/** An utterance woken early and shorter than this is a bare « Hi Atlas »: no grace. */
const BARE_WAKE_SECONDS = 1.5;
/** Silence put between the parts of a command joined across a pause (word boundary for speech-to-text). */
const JOIN_GAP_SECONDS = 0.3;

export interface PipelineOptions {
  onEvent: (e: VoiceEvent) => void;
  /** Silence that ends an utterance. */
  silenceSeconds?: number;
  /** After a bare « Hi Atlas », give up when no command starts within this time. */
  commandTimeoutSeconds?: number;
  /** Wake word sensitivity, 0 (low) … 1 (high), default 0.5: see sensitivitySettings(). */
  sensitivity?: number;
  /**
   * Called with the transcript before a wake fires; false = not a wake (the utterance is dropped). The voice loop uses
   * it to ignore its own voice: « Atlas » heard while the sentence being played says « Atlas ».
   */
  acceptWake?: (text: string) => boolean;
  /** Every utterance transcribed, with what became of it (diagnostics: Atlas's voice log in debug mode). */
  onHeard?: (text: string, outcome: 'dropped' | 'wake' | 'command' | 'stale') => void;
}

/**
 * What wakes the pipeline: 'phrase' = « hi / hey Atlas » (waiting), 'name' = barge-in while Atlas is speaking:
 * « Atlas » alone anywhere in a sentence (« Atlas, stop »), or an utterance opening with a stop word, English or
 * Turkish (« stop », « wait », « no », « dur », « hayır », « bekle », « sus », « yeter »): see afterBargeIn.
 */
export type WakeMode = 'phrase' | 'name';

/**
 * Wake word → command over 16 kHz mono float frames (any frame size).
 *
 * Silero VAD cuts the audio into utterances (speech until `silenceSeconds` of silence); the VAD keeps each utterance
 * from its first sound, so nothing said in one breath is lost. A command cut by a short pause is held a little longer
 * and joined with what follows (pauseGraceSeconds). Each utterance is transcribed locally by Whisper (English or Turkish):
 * - listening: kept only if it starts with « hi/hey Atlas »; anything else is dropped on the spot (text included).
 *   « Hi Atlas, what's on the board? » → wake + command. A bare « Hi Atlas » → wake, then the next utterance is the command.
 * - capturing (after a bare wake, or startCapture() for follow-ups): the next utterance is the command.
 * Transcriptions run one at a time, in order, off the main thread; the VAD keeps listening meanwhile.
 * Early wake: while an utterance is still going, its first seconds are transcribed every ~250 ms, so « wake » fires
 * right after « Hi Atlas » is said, not after the whole « Hi Atlas, what's on the board today? ».
 *
 * Why no keyword spotter: sherpa-onnx's KWS (gigaspeech 3.3M, « ▁HI ▁AT LA S ») missed most wakes on the fixtures
 * once it had run a while (its auto-reset after 1.5 s of silence leaves the encoder cold), see docs/voice-research.md.
 */
export class VoicePipeline {
  private capturing = false;
  private readonly vad: Vad;
  private fed = 0;
  /** Samples of silence while capturing, for the command timeout. */
  private idle = 0;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  /** Bumped by reset(): transcriptions queued before it are dropped. */
  private epoch = 0;
  private readonly timeoutSamples: number;
  private readonly strictWake: boolean;
  /** Recent audio (EARLY_SECONDS + pad), for the early wake check. */
  private readonly recent = new Float32Array(Math.round((EARLY_SECONDS + 0.5) * SAMPLE_RATE));
  /** Fed-sample position where the current utterance's speech began; undefined between utterances. */
  private speechStart: number | undefined;
  /** The current utterance already fired wake (early). */
  private wokeEarly = false;
  private earlyInFlight = false;
  private lastEarlyCheck = 0;
  private mode: WakeMode = 'phrase';
  /** A command utterance cut by a pause, held for the pause grace (see pauseGraceSeconds). */
  private held: { samples: Float32Array; woken: boolean; speech: number; cutAt: number; until: number } | undefined;
  private readonly silenceSamples: number;
  /**
   * A second, quick speech detector (0.05 s of speech): the main one only confirms speech after 0.25 s, too late to
   * notice Master starting again within the pause grace. Its segments are thrown away.
   */
  private readonly onset: Vad;
  /** Push-to-talk held (hold ⌥, card #75): every frame since holdStart(), no speech detector, no wake word. */
  private hold: { parts: Float32Array[]; samples: number; speech: boolean } | null = null;

  constructor(
    private readonly models: VoiceModels,
    private readonly opts: PipelineOptions,
  ) {
    const { vadThreshold, strictWake } = sensitivitySettings(opts.sensitivity ?? 0.5);
    this.strictWake = strictWake;
    this.silenceSamples = Math.round((opts.silenceSeconds ?? 0.8) * SAMPLE_RATE);
    const vad = (minSilenceDuration: number, minSpeechDuration: number, bufferSeconds: number) =>
      new sherpa.Vad(
        {
          sileroVad: { model: models.vadModel, threshold: vadThreshold, minSilenceDuration, minSpeechDuration, maxSpeechDuration: 30, windowSize: 512 },
          sampleRate: SAMPLE_RATE,
          numThreads: 1,
          provider: 'cpu',
          debug: 0,
        },
        bufferSeconds,
      );
    this.vad = vad(opts.silenceSeconds ?? 0.8, MIN_SPEECH_SECONDS, 60);
    this.onset = vad(0.1, 0.05, 5);
    this.timeoutSamples = Math.round((opts.commandTimeoutSeconds ?? 8) * SAMPLE_RATE);
  }

  setWakeMode(mode: WakeMode): void {
    this.mode = mode;
  }

  get wakeMode(): WakeMode {
    return this.mode;
  }

  /** What follows the wake words in `text` (maybe ''), or undefined when it holds none for the current mode. */
  private afterWake(text: string): string | undefined {
    const rest = afterWakePhrase(text, this.strictWake);
    return rest !== undefined || this.mode === 'phrase' ? rest : afterBargeIn(text);
  }

  private accept(text: string): boolean {
    return this.opts.acceptWake?.(text) ?? true;
  }

  get listening(): boolean {
    return !this.capturing;
  }

  /** Someone is talking, or what they said is still being handled (held for the pause grace, being transcribed). */
  get hearing(): boolean {
    return this.vad.isDetected() || !!this.held || this.pending > 0 || !!this.hold;
  }

  /** Push-to-talk is held: audio is being recorded. */
  get holding(): boolean {
    return !!this.hold;
  }

  /**
   * Push-to-talk held (hold ⌥, card #75): from now on every frame is recorded as is (the speech detector does not cut
   * it: Master may pause as long as they like) until holdEnd() sends it or holdCancel() drops it. The detector only
   * says whether anyone spoke at all (Whisper « hears » words in silence).
   */
  holdStart(): void {
    this.reset();
    this.hold = { parts: [], samples: 0, speech: false };
  }

  /**
   * Push-to-talk released: what was recorded goes to speech-to-text at once, then 'command' (or 'timeout' when
   * nothing was said). No silence to wait for.
   */
  holdEnd(): void {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    this.vad.reset(); // the held speech is not an utterance of its own afterwards
    this.onset.reset();
    this.speechStart = undefined;
    const all = new Float32Array(h.samples);
    let at = 0;
    for (const p of h.parts) (all.set(p, at), (at += p.length));
    const epoch = this.epoch;
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        if (epoch !== this.epoch) return;
        const t0 = performance.now();
        const raw = h.speech ? await this.models.transcribe(all) : '';
        if (epoch !== this.epoch) return;
        this.opts.onHeard?.(raw, raw.trim() ? 'command' : 'dropped');
        const text = raw.trim();
        this.opts.onEvent(text ? { type: 'command', text, raw, endSample: this.fed, sttMs: performance.now() - t0, tailMs: 0 } : { type: 'timeout' });
      } catch (e) {
        this.opts.onEvent({ type: 'error', error: e instanceof Error ? e : new Error(String(e)) });
      } finally {
        this.pending--;
      }
    });
  }

  /** Push-to-talk cancelled (another key or a click while ⌥ was held): what was recorded is dropped. */
  holdCancel(): void {
    this.hold = null;
    this.reset();
  }

  /** Feed the next frame of microphone audio. */
  feed(samples: Float32Array): void {
    if (this.hold) {
      this.fed += samples.length;
      const part = samples.slice(0, HOLD_MAX_SECONDS * SAMPLE_RATE - this.hold.samples);
      this.hold.parts.push(part);
      this.hold.samples += part.length;
      for (let i = 0; i < part.length; i += 512) {
        this.vad.acceptWaveform(part.subarray(i, i + 512));
        if (this.vad.isDetected()) this.hold.speech = true;
        while (!this.vad.isEmpty()) (this.vad.pop(), (this.hold.speech = true));
      }
      if (this.hold.samples >= HOLD_MAX_SECONDS * SAMPLE_RATE) this.holdEnd(); // held that long: sent as if released
      return;
    }
    // 512-sample windows: sherpa's VAD gets a segment's start wrong (empty segment) when one call spans several.
    for (let i = 0; i < samples.length; i += 512) {
      const w = samples.subarray(i, i + 512);
      this.remember(w);
      this.fed += w.length;
      this.vad.acceptWaveform(w);
      this.onset.acceptWaveform(w);
      while (!this.onset.isEmpty()) this.onset.pop();
      while (!this.vad.isEmpty()) {
        const seg = this.vad.front(false);
        this.vad.pop();
        if (seg.samples.length) this.segment(seg.samples);
        this.speechStart = undefined;
        this.wokeEarly = false;
      }
      // the pause grace is over and Master has not started again: send what was held
      if (this.held && this.fed >= this.held.until && !this.vad.isDetected() && !this.onset.isDetected()) this.release();
      if (this.vad.isDetected()) {
        this.speechStart ??= Math.max(0, this.fed - Math.round(0.6 * SAMPLE_RATE)); // silero flags speech ~0.3–0.5 s in
        this.earlyCheck();
      }
      this.idle = this.capturing && !this.pending && !this.held && !this.vad.isDetected() ? this.idle + w.length : 0;
      if (this.capturing && this.idle >= this.timeoutSamples) {
        this.capturing = false;
        this.idle = 0;
        this.opts.onEvent({ type: 'timeout' });
      }
    }
  }

  /** An utterance the VAD has cut: a command part is held for the pause grace, anything else is transcribed now. */
  private segment(samples: Float32Array) {
    if (this.mode === 'phrase' && !this.held && samples.length < WAKE_MIN_SPEECH * SAMPLE_RATE) return;
    const h = this.held;
    const woken = this.wokeEarly || !!h?.woken;
    const speech = (h?.speech ?? 0) + samples.length / SAMPLE_RATE;
    if (h) {
      const gap = new Float32Array(Math.round(JOIN_GAP_SECONDS * SAMPLE_RATE));
      const all = new Float32Array(h.samples.length + gap.length + samples.length);
      all.set(h.samples);
      all.set(samples, h.samples.length + gap.length);
      samples = all;
    }
    const command = this.capturing || (woken && speech >= BARE_WAKE_SECONDS);
    if (!command) {
      this.held = undefined;
      return this.enqueue(samples, this.fed, woken, this.silenceSamples);
    }
    this.held = { samples, woken, speech, cutAt: this.fed, until: this.fed + Math.round(pauseGraceSeconds(speech) * SAMPLE_RATE) };
  }

  private release() {
    const h = this.held!;
    this.held = undefined;
    this.enqueue(h.samples, this.fed, h.woken, this.silenceSamples + this.fed - h.cutAt);
  }

  private remember(w: Float32Array) {
    const r = this.recent;
    if (w.length >= r.length) return r.set(w.subarray(w.length - r.length));
    r.copyWithin(0, w.length);
    r.set(w, r.length - w.length);
  }

  /**
   * While listening, looks for « Hi Atlas » in the first EARLY_SECONDS of the utterance under way; in barge-in mode for
   * « Atlas » or a stop word in its last EARLY_SECONDS.
   */
  private earlyCheck() {
    // barge-in: no waiting for an earlier utterance (Atlas's echo) to be handled first, a « stop » must stop at once
    const busy = this.mode === 'phrase' && this.pending > 0;
    if (this.capturing || this.wokeEarly || this.earlyInFlight || busy || this.held || this.speechStart === undefined) return;
    const len = this.fed - this.speechStart;
    // barge-in: Atlas's echo can keep the speech detector on for its whole sentence, so the « stop » said over it is
    // looked for in the last BARGE_SECONDS, however long the utterance has been going
    const window = this.mode === 'name' ? Math.min(len, BARGE_SECONDS * SAMPLE_RATE) : len;
    if (this.mode === 'phrase' && len > EARLY_SECONDS * SAMPLE_RATE) return;
    if (this.fed - this.lastEarlyCheck < EARLY_EVERY * SAMPLE_RATE) return;
    this.lastEarlyCheck = this.fed;
    const audio = this.recent.slice(this.recent.length - window);
    const { epoch, fed } = this;
    this.earlyInFlight = true;
    const t0 = performance.now();
    // barge-in: decoded as Turkish, no language detection. Over Atlas's English echo, detection picks English (or
    // Russian) and loses a short Turkish « dur » / « sus »; Turkish decoding still writes « Stop. », « Wait. », « No »,
    // « Atlas » as said (card #53, docs/voice-research.md). The command itself comes from the full utterance, detected.
    this.models
      .transcribe(audio, this.mode === 'name' ? 'tr' : undefined)
      .then((text) => {
        // only if still the same utterance and nothing else claimed it meanwhile
        if (epoch !== this.epoch || this.capturing || this.wokeEarly || this.speechStart === undefined || this.fed - this.speechStart < len) return;
        if (this.afterWake(text) === undefined || !this.accept(text)) return;
        this.wokeEarly = true;
        this.opts.onEvent({ type: 'wake', atSample: fed, sttMs: performance.now() - t0, text });
      })
      .catch((e: unknown) => this.opts.onEvent({ type: 'error', error: e instanceof Error ? e : new Error(String(e)) }))
      .finally(() => (this.earlyInFlight = false));
  }

  /** Take the next utterance as a command, without the wake word (follow-up questions). */
  startCapture(): void {
    this.capturing = true;
    this.idle = 0;
  }

  /** Back to waiting for the wake word; queued transcriptions are dropped. */
  reset(): void {
    this.epoch++;
    this.hold = null;
    this.capturing = false;
    this.idle = 0;
    this.vad.reset();
    this.onset.reset();
    this.held = undefined;
    this.speechStart = undefined;
    this.wokeEarly = false;
  }

  /** Resolves when every queued transcription has been handled (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.pending || this.earlyInFlight) await (this.pending ? this.queue : new Promise((r) => setTimeout(r, 5)));
  }

  private enqueue(samples: Float32Array, endSample: number, woken: boolean, tailSamples: number) {
    const epoch = this.epoch;
    this.pending++;
    this.queue = this.queue.then(async () => {
      try {
        if (epoch === this.epoch) await this.handle(samples, endSample, woken, tailSamples);
      } catch (e) {
        this.capturing = false;
        this.opts.onEvent({ type: 'error', error: e instanceof Error ? e : new Error(String(e)) });
      } finally {
        this.pending--;
      }
    });
  }

  /** `woken`: this utterance already fired wake early (its full transcript decides what the command is). */
  private async handle(samples: Float32Array, endSample: number, woken: boolean, tailSamples: number) {
    const t0 = performance.now();
    let raw = await this.models.transcribe(samples);
    // barge-in mode, nothing found: once more as Turkish (a short « dur » under Atlas's echo, see earlyCheck)
    if (this.mode === 'name' && !woken && !this.capturing && afterBargeIn(raw) === undefined) {
      const tr = await this.models.transcribe(samples, 'tr');
      if (afterBargeIn(tr) !== undefined) raw = tr;
    }
    const sttMs = performance.now() - t0;
    // woken early in barge-in mode: « Atlas, stop » / « hayır » has no « hi », whatever the mode is now
    const rest = this.afterWake(raw) ?? (woken ? afterBargeIn(raw) : undefined);
    this.opts.onHeard?.(raw, this.capturing && raw.trim() ? 'command' : rest !== undefined || woken ? 'wake' : 'dropped');
    if (!this.capturing) {
      if (rest === undefined && !woken) return; // not for Atlas: dropped
      if (!woken && !this.accept(raw)) return;
      if (!woken) this.opts.onEvent({ type: 'wake', atSample: endSample, sttMs, text: raw });
      if (!rest) {
        this.startCapture();
        return this.opts.onEvent({ type: 'awaiting', sttMs });
      }
    }
    const text = rest ?? raw.trim();
    if (!text) return; // capturing, and only the wake phrase again: keep waiting for the command
    this.capturing = false;
    this.opts.onEvent({ type: 'command', text, raw, endSample, sttMs, tailMs: (tailSamples / SAMPLE_RATE) * 1000 });
  }
}
