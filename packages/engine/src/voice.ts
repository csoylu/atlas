import { MODEL_IDS, MODELS, fetchModel, isInstalled, type ModelId, type ModelSpec } from '@atlas/voice/models';
import { UpdateVoice, defaultPttShortcut, VOICE_NAMES, type MicAccess, type VoiceName, type VoiceStatus } from '@atlas/shared';
import type { Db } from './store/db.ts';
import type { Bus } from './events.ts';
import { ConflictError } from './kanban.ts';

/** What the desktop app provides for voice mode (it owns the models folder and asks macOS for the microphone). */
export interface VoiceHost {
  modelsDir: string;
  micAccess(): MicAccess;
  /** Shows the macOS permission prompt (once; later calls answer from the saved choice). True when allowed. */
  requestMicAccess(): Promise<boolean>;
}

const LABELS: Record<ModelId, string> = { vad: 'Speech detector (Silero VAD)', stt: 'Speech to text (Whisper large-v3-turbo, English + Turkish)', tts: 'Voice (Supertonic 3, English + Turkish)' };

/** The models package loads lazily: sherpa-onnx's native addon is only needed to speak (Test voice) and listen. */
type VoiceLib = typeof import('@atlas/voice');
type Models = Awaited<ReturnType<VoiceLib['VoiceModels']['load']>>;

/**
 * Settings → Voice (desktop only). Settings live in the settings table (voice_enabled, voice_name, voice_sensitivity, voice_wake_word,
 * voice_ptt, voice_ptt_key).
 * Turning voice on downloads the missing models (resumable, checksum-verified: @atlas/voice fetchModel) and asks for
 * the microphone. An engine restart with voice on resumes an unfinished download (CLAUDE.md rule 2).
 */
export class Voice {
  private abort: AbortController | null = null;
  private download: VoiceStatus['download'] = null;
  private error: string | null = null;
  private lastEmit = 0;
  private tts: Promise<Models> | null = null;
  /** Ends a timed pause (« Pause listening for 1 hour »): voice.updated, so the desktop reopens the microphone. */
  private pauseTimer: ReturnType<typeof setTimeout> | null = null;
  /** The push-to-talk shortcut could not be registered (desktop app: setPttError). Not stored: retried on every start. */
  private pttError: string | null = null;
  /** pttError is about macOS's Input Monitoring permission (hold ⌥, card #75). */
  private pttPermission = false;

  constructor(
    private db: Db,
    private bus: Bus,
    private host: VoiceHost,
    /** Tests point the downloads at a local server. */
    private specs: Record<ModelId, ModelSpec> = MODELS,
    private now: () => number = Date.now,
    /** The default push-to-talk follows the platform (hold ⌥ on a Mac, card #75). */
    private platform: string = process.platform,
  ) {}

  /** Where the voice models live (the desktop's voice loop loads them from here). */
  get modelsDir(): string {
    return this.host.modelsDir;
  }

  status(): VoiceStatus {
    const models = MODEL_IDS.map((id) => ({ id, label: LABELS[id], bytes: this.specs[id].bytes, installed: isInstalled(this.host.modelsDir, this.specs[id]) }));
    const enabled = this.get('voice_enabled') === '1';
    const mic = this.host.micAccess();
    const paused = enabled ? this.paused() : null;
    return {
      enabled,
      voice: (VOICE_NAMES as readonly string[]).includes(this.get('voice_name') ?? '') ? (this.get('voice_name') as VoiceName) : VOICE_NAMES[0],
      sensitivity: Number(this.get('voice_sensitivity') ?? 0.5),
      models,
      download: this.download,
      mic,
      error: this.error,
      paused,
      ready: enabled && !paused && mic === 'granted' && models.every((m) => m.installed),
      wakeWord: this.get('voice_wake_word') !== '0',
      ptt: { enabled: this.get('voice_ptt') !== '0', shortcut: this.get('voice_ptt_key') ?? defaultPttShortcut(this.platform), error: this.pttError, permission: this.pttPermission },
    };
  }

  /** voice_paused_until: 'resume' (until Master resumes) or an ISO time; a time already past is no pause. */
  private paused(): VoiceStatus['paused'] {
    const v = this.get('voice_paused_until');
    if (!v) return null;
    if (v === 'resume') return { until: null };
    return Date.parse(v) > this.now() ? { until: v } : null;
  }

  /** On engine start: voice was on with models missing (download interrupted) → carry on; a timed pause resumes on time. */
  start(): void {
    if (this.get('voice_enabled') === '1') void this.ensureModels();
    this.armPause();
  }

  stop(): void {
    this.abort?.abort();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
  }

  /** A timer to the end of a timed pause (re-armed in steps: setTimeout holds at most ~24 days). */
  private armPause(): void {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const until = this.paused()?.until;
    if (!until) return;
    const ms = Math.min(Date.parse(until) - this.now(), 2 ** 31 - 1);
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (this.paused()) return this.armPause();
      this.del('voice_paused_until');
      this.emit(true);
    }, Math.max(0, ms) + 50);
    this.pauseTimer.unref?.();
  }

  async update(patch: unknown): Promise<VoiceStatus> {
    const p = UpdateVoice.parse(patch);
    if (p.voice !== undefined) this.set('voice_name', p.voice);
    if (p.sensitivity !== undefined) this.set('voice_sensitivity', String(p.sensitivity));
    if (p.wakeWord !== undefined) this.set('voice_wake_word', p.wakeWord ? '1' : '0');
    if (p.ptt !== undefined) this.set('voice_ptt', p.ptt ? '1' : '0');
    if (p.pttShortcut !== undefined) this.set('voice_ptt_key', p.pttShortcut);
    if (p.ptt !== undefined || p.pttShortcut !== undefined) [this.pttError, this.pttPermission] = [null, false]; // the desktop app registers it again
    if (p.pause !== undefined) {
      if (p.pause && this.get('voice_enabled') !== '1') throw new ConflictError('voice mode is off: nothing to pause');
      if (p.pause?.until && Date.parse(p.pause.until) <= this.now()) throw new ConflictError('the pause must end in the future');
      if (p.pause) this.set('voice_paused_until', p.pause.until ? new Date(p.pause.until).toISOString() : 'resume');
      else this.del('voice_paused_until');
      this.armPause();
    }
    // turning voice on or off ends a pause: voice turned on again later listens at once
    if (p.enabled !== undefined) {
      this.del('voice_paused_until');
      this.armPause();
    }
    if (p.enabled === false) {
      this.set('voice_enabled', '0');
      this.abort?.abort(); // the partial file stays: turning on again resumes it
    }
    if (p.enabled === true) {
      this.set('voice_enabled', '1');
      void this.ensureModels();
      if (this.host.micAccess() !== 'granted') await this.host.requestMicAccess();
    }
    return this.emit(true);
  }

  /** Downloads every missing model, one after the other. Errors land in status.error (shown on the page). */
  async ensureModels(): Promise<void> {
    if (this.abort) return; // already downloading
    const missing = MODEL_IDS.filter((id) => !isInstalled(this.host.modelsDir, this.specs[id]));
    if (!missing.length) return;
    const abort = (this.abort = new AbortController());
    this.error = null;
    const total = missing.reduce((s, id) => s + this.specs[id].bytes, 0);
    let done = 0;
    try {
      for (const id of missing) {
        this.download = { received: done, total, model: LABELS[id] };
        this.emit(true);
        await fetchModel(this.host.modelsDir, this.specs[id], (p) => {
          this.download = { received: done + p.received, total, model: LABELS[id] };
          this.emit();
        }, abort.signal);
        done += this.specs[id].bytes;
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        this.error = `Voice model download failed: ${e instanceof Error ? e.message : String(e)}`;
        console.error(this.error);
      }
    } finally {
      this.abort = null;
      this.download = null;
      this.emit(true);
    }
  }

  /**
   * The desktop app (could not) register the push-to-talk shortcut: shown in Settings → Voice. `permission`: macOS has
   * not allowed Input Monitoring (Settings shows a button to its pane).
   */
  setPttError(error: string | null, permission = false): void {
    if (error === this.pttError && permission === this.pttPermission) return;
    this.pttError = error;
    this.pttPermission = error !== null && permission;
    this.emit(true);
  }

  /** « Test voice »: one sentence in the chosen voice, as a WAV file. */
  async test(voice: VoiceName, userName: string): Promise<Buffer> {
    if (!isInstalled(this.host.modelsDir, this.specs.tts)) throw new ConflictError('the voice model is not downloaded yet: turn voice on first');
    const lib = await import('@atlas/voice');
    this.tts ??= lib.VoiceModels.load(this.host.modelsDir, { only: ['tts'] });
    let models: Models;
    try {
      models = await this.tts;
    } catch (e) {
      this.tts = null;
      throw e;
    }
    const name = userName === 'the user' ? '' : `, ${userName}`;
    const { samples, sampleRate } = await models.synthesize(`Yes${name}? This is how I will sound when you say hi Atlas.`, voice);
    return wav(samples, sampleRate);
  }

  private emit(force = false): VoiceStatus {
    const status = this.status();
    // progress arrives per network chunk: a few updates a second are enough
    if (force || Date.now() - this.lastEmit > 250) {
      this.lastEmit = Date.now();
      this.bus.emit({ type: 'voice.updated', status });
    }
    return status;
  }

  private get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  private del(key: string): void {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  private set(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
}

/** Mono float PCM → 16-bit PCM WAV. */
export function wav(samples: Float32Array, sampleRate: number): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return b;
}
