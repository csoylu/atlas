import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Engine } from '@atlas/engine';
import { PTT_HOLD_OPTION, pttAction, pttShortcutLabel } from '@atlas/shared';
import type { LoopMetric, LoopState, VoiceLoop } from '@atlas/voice';
import type { OrbOverlay } from './orb/overlay.ts';
import type { HoldEvent, HoldKeyPort } from './optionkey.ts';

const MIC_SILENT_MS = 10_000;
const DEBUG = process.env.ATLAS_VOICE_DEBUG === '1';

/** What the voice loop uses of the orb overlay (a fake in tests). */
export type VoiceOrb = Pick<OrbOverlay, 'setState' | 'transcript' | 'speak' | 'hush' | 'error' | 'dismiss' | 'mic'>;

/** Electron's globalShortcut, as push-to-talk uses it (a fake in tests). */
export interface ShortcutPort {
  /** False when the shortcut can't be had (another app holds it). May throw on a malformed accelerator. */
  register(accelerator: string, onPress: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * Voice mode's conversation loop in the desktop app: the orb page's microphone → the wake word pipeline (main process,
 * sherpa-onnx) → the « Voice » chat (engine) → the reply spoken by the orb. Runs while voice mode is ready (on, models
 * downloaded, microphone allowed); rebuilt when the sensitivity changes. Metrics and errors go to logs/voice.log.
 */
export class DesktopVoice {
  private loop: VoiceLoop | null = null;
  private starting: Promise<void> | null = null;
  private sensitivity: number | null = null;
  private models: Promise<import('@atlas/voice').VoiceModels> | null = null;
  /** Microphone watchdog (fail loudly): when audio last came, and when it was last more than digital silence. */
  private heardAt = 0;
  private soundAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private deaf: string | null = null;
  private peak = 0;
  private peakAt = 0;
  private unwatch: (() => void) | null = null;
  /** The microphone is wanted open (see updateMic); frames that still come while it is not are dropped. */
  private micOn = false;
  /** The push-to-talk shortcut registered now (Electron accelerator, or PTT_HOLD_OPTION: ⌥ watched). */
  private ptt: string | null = null;

  constructor(
    private readonly engine: Engine,
    private readonly orb: VoiceOrb,
    private readonly logFile: string,
    /** The loop started or stopped (the menu bar orb's « Start talking » follows it). */
    private readonly onChange: () => void = () => {},
    /** Global shortcuts (push-to-talk, card #57). */
    private readonly shortcuts: ShortcutPort | null = null,
    /** Hold ⌥ alone (push-to-talk as a walkie-talkie, card #75). */
    private readonly holdKey: HoldKeyPort | null = null,
  ) {
  }

  /** The loop is running (models loaded, listening for « Hi Atlas »). */
  get running(): boolean {
    return this.loop !== null;
  }

  /** The microphone is open (or opening) for the voice loop. */
  get listening(): boolean {
    return this.micOn;
  }

  /** « Start talking » in the menu bar orb (card #54): as if Master said « Hi Atlas ». */
  talk(): void {
    const loop = this.ready();
    this.log('Start talking (menu bar)');
    loop.wakeNow();
  }

  /**
   * The push-to-talk shortcut (card #57). At rest: as « Hi Atlas » (the microphone opens with the orb). While Atlas
   * thinks or speaks: interrupts it and listens. While it listens: ends the conversation, as Esc (Master, 14 Nov 2026).
   */
  push(): void {
    const loop = this.ready();
    const st = loop.state;
    this.log(`push-to-talk (${st})`);
    if (st === 'wake' || st === 'listening') loop.escape();
    else loop.wakeNow();
  }

  /**
   * Hold ⌥ (card #75), a walkie-talkie: held → listening (interrupts Atlas); released → what was said is sent at once;
   * another key or a click while ⌥ is down → cancelled, nothing sent.
   */
  hold(e: HoldEvent): void {
    const loop = this.ready();
    this.log(`hold ⌥: ${e} (${loop.state})`);
    if (e === 'start') loop.holdStart();
    else if (e === 'end') loop.holdEnd();
    else loop.holdCancel();
  }

  private ready(): VoiceLoop {
    if (!this.loop) throw new Error('voice mode is not running: turn it on (and wait until it says Ready) first');
    return this.loop;
  }

  /**
   * The microphone is open while the wake word listens, while a conversation is under way (from the wake to the end of
   * the follow-up window, announcements included: barge-in). Wake word off: closed at
   * rest, nothing transcribed (card #57). `state`: the loop's state being entered (onState fires before it changes).
   */
  private updateMic(state: LoopState | undefined = this.loop?.state) {
    const status = this.engine.voice!.status();
    const on = status.enabled && !status.paused && (status.wakeWord || (state !== undefined && state !== 'idle'));
    if (on === this.micOn) return;
    this.micOn = on;
    this.heardAt = this.soundAt = performance.now(); // the watchdog gives a freshly opened microphone its 10 s
    this.deaf = null;
    this.log(on ? 'microphone open' : 'microphone closed (wake word off: nothing listens until the push-to-talk shortcut)');
    this.orb.mic(on);
    this.onChange();
  }

  /** Registers (or releases) the push-to-talk shortcut: while the loop runs and push-to-talk is on. Fails loudly. */
  private updateShortcut() {
    if (!this.shortcuts && !this.holdKey) return;
    const p = this.engine.voice!.status().ptt;
    const want = this.loop && p.enabled ? p.shortcut : null;
    if (want === this.ptt) return;
    this.release();
    if (!want) return this.engine.voice!.setPttError(null);
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.error(err);
        this.orb.error(err.message);
      }
    };
    if (want === PTT_HOLD_OPTION) {
      if (!this.holdKey) return this.engine.voice!.setPttError('Hold ⌥ is not available here: pick a shortcut such as ⌥ Space.');
      this.ptt = want;
      this.holdKey.watch(
        (e) => guard(() => this.hold(e)),
        (problem) => {
          if (this.ptt !== want) return;
          if (problem) this.log(`ERROR push-to-talk: ${problem}`);
          else this.log('push-to-talk: hold ⌥ watched');
          this.engine.voice!.setPttError(problem, problem !== null);
        },
      );
      return;
    }
    if (!this.shortcuts) return this.engine.voice!.setPttError(`${pttShortcutLabel(want)} is not available here.`);
    let ok: boolean;
    try {
      ok = this.shortcuts.register(want, () => guard(() => this.push()));
    } catch (e) {
      ok = false;
      this.error(e instanceof Error ? e : new Error(String(e)));
    }
    if (!ok) {
      const msg = `${pttShortcutLabel(want)} could not be registered: another app already uses it. Pick another shortcut.`;
      this.log(`ERROR push-to-talk: ${msg}`);
      this.engine.voice!.setPttError(msg);
      return;
    }
    this.ptt = want;
    this.engine.voice!.setPttError(null);
    this.log(`push-to-talk shortcut ${pttShortcutLabel(want)} registered`);
  }

  /** Releases the push-to-talk shortcut (or stops watching ⌥). */
  private release() {
    if (this.ptt === PTT_HOLD_OPTION) this.holdKey?.unwatch();
    else if (this.ptt) this.shortcuts?.unregister(this.ptt);
    this.ptt = null;
  }

  /** Microphone frames from the orb page. Dropped until the models are loaded. */
  feed(samples: Float32Array): void {
    const now = performance.now();
    this.heardAt = now;
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    if (peak > 0) this.soundAt = now; // exact zeros: a muted input
    if (DEBUG) {
      this.peak = Math.max(this.peak, peak);
      if (now - this.peakAt > 10_000) {
        this.log(`mic peak over 10 s: ${this.peak.toFixed(4)}`);
        this.peak = 0;
        this.peakAt = now;
      }
    }
    if (this.micOn) this.loop?.feed(samples); // a frame still in flight after the microphone closed: dropped
  }

  /** No microphone audio, or only digital zeros (muted input, lid closed), for 10 s while listening: say so. */
  private checkMic() {
    if (!this.loop || !this.micOn) return;
    const now = performance.now();
    const problem =
      now - this.heardAt > MIC_SILENT_MS
        ? 'No audio from the microphone: voice mode cannot hear « Hi Atlas ».'
        : now - this.soundAt > MIC_SILENT_MS
          ? 'The microphone sends only silence (muted, or the MacBook lid is closed): voice mode cannot hear « Hi Atlas ».'
          : null;
    if (problem === this.deaf) return;
    this.deaf = problem;
    this.log(problem ? `ERROR ${problem}` : 'microphone audio is back');
    if (problem) this.orb.error(problem);
  }

  escape(): void {
    this.log('Esc');
    if (this.loop) this.loop.escape();
    else this.orb.dismiss();
  }

  dismissed(): void {
    this.log('orb dismissed (Master clicked the orb)');
    this.loop?.dismissed();
  }

  /** Follows Settings → Voice: starts, rebuilds (sensitivity changed) or stops the loop. */
  sync(): void {
    const status = this.engine.voice!.status();
    if (!status.ready) {
      if (this.loop) {
        this.log(`stopped (${status.paused ? 'listening paused' : 'voice mode off or not ready'})`);
        this.loop.dismissed(); // the orb back at rest, nothing more said
      }
      this.loop = null;
      this.updateMic();
      this.updateShortcut();
      this.unwatch?.();
      this.unwatch = null;
      if (this.watchdog) clearInterval(this.watchdog);
      this.watchdog = null;
      this.sensitivity = null;
      this.onChange();
      return;
    }
    this.updateMic();
    this.updateShortcut(); // a new shortcut, or push-to-talk turned on or off
    if (this.loop && this.sensitivity === status.sensitivity) return;
    this.starting ??= this.start(status.sensitivity)
      .catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.error(err);
        this.orb.error(`Voice mode could not start: ${err.message}`); // fail loudly, on the orb too
      })
      .finally(() => (this.starting = null));
  }

  private async start(sensitivity: number) {
    const lib = await import('@atlas/voice');
    const t0 = performance.now();
    this.models ??= lib.VoiceModels.load(this.engine.voice!.modelsDir);
    let models;
    try {
      models = await this.models;
    } catch (e) {
      this.models = null;
      throw e;
    }
    const chat = this.engine.voiceChat!;
    const loop = new lib.VoiceLoop({
      models,
      orb: this.orb,
      chat,
      userName: () => this.engine.settings.user().name,
      voice: () => this.engine.voice!.status().voice,
      sensitivity,
      onMetric: (m) => this.metric(m),
      onState: (from, to) => {
        this.log(`state ${from} → ${to}`);
        if (this.loop === loop) this.updateMic(to);
      },
      // what was said is private: in the log only in debug mode (open -a Atlas --env ATLAS_VOICE_DEBUG=1)
      onHeard: (text, outcome) => this.log(`heard (${outcome})${DEBUG ? `: ${JSON.stringify(text)}` : `: ${text.split(/\s+/).filter(Boolean).length} words`}`),
      onError: (e) => this.error(e),
    });
    await loop.warm();
    chat.id(); // the Voice chat exists from the start (fails loudly without an agent)
    if (!this.engine.voice!.status().ready) return; // turned off meanwhile
    // every other reply in the Voice chat (card reports, typed messages) is said aloud too while voice mode runs (#52)
    this.unwatch ??= chat.watch((text) => {
      if (!this.loop) return;
      this.log(`reply to announce (${text.split(/\s+/).filter(Boolean).length} words)`);
      this.loop.announce(text);
    });
    this.loop?.dismissed();
    this.loop = loop;
    this.sensitivity = sensitivity;
    this.heardAt = this.soundAt = performance.now();
    this.deaf = null;
    this.watchdog ??= setInterval(() => this.checkMic(), 2000);
    this.updateMic();
    this.updateShortcut();
    this.onChange();
    const s = this.engine.voice!.status();
    const how = [s.wakeWord && '« Hi Atlas »', s.ptt.enabled && pttAction(s.ptt.shortcut)].filter(Boolean).join(' or ') || 'nothing (wake word and push-to-talk both off)';
    this.log(`ready: listening for ${how} (models ready in ${Math.round(performance.now() - t0)} ms, sensitivity ${sensitivity})`);
  }

  private metric(m: LoopMetric) {
    this.log(`${m.name} ${Math.round(m.ms)} ms${m.parts ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(m.parts).map(([k, v]) => [k, Math.round(v)]))) : ''}`);
  }

  /** Releases the shortcut and the microphone watchdog (app quit, tests). */
  stop(): void {
    this.release();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.unwatch?.();
    this.unwatch = null;
    this.loop = null;
  }

  error(e: Error): void {
    console.error('[voice]', e);
    this.log(`ERROR ${e.stack ?? e.message}`);
  }

  private log(line: string) {
    voiceLog(this.logFile, line);
  }
}

/** One line in logs/voice.log. */
export function voiceLog(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
}
