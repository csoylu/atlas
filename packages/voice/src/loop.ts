import { saysStopWord, splitSentences, stopWord, type VoiceModels, type VoiceName } from './engine.ts';
import { VoicePipeline, type VoiceEvent } from './pipeline.ts';

export type LoopState = 'idle' | 'wake' | 'listening' | 'thinking' | 'speaking';

/** The orb overlay, as the loop drives it (apps/desktop OrbOverlay; a recorder in tests). */
export interface OrbPort {
  setState(state: LoopState): void;
  /** What Master said (shown in the caption). */
  transcript(text: string): void;
  /** Plays one sentence and types it in the caption. Resolves when heard (true) or cut off (false). */
  speak(text: string, samples: Float32Array, sampleRate: number): Promise<boolean>;
  /** Stops playing now (barge-in), stays awake. Pending speak() promises resolve false. */
  hush(): void;
  /** Shown on the orb (fail loudly). */
  error(message: string): void;
}

/** The dedicated Voice chat (engine VoiceChat). */
export interface ChatPort {
  /**
   * Posts Master's message; `onText` gets the reply's text as it streams; resolves when the agent has finished.
   * Aborting stops listening to the reply (the agent's answer still lands in the chat).
   */
  ask(text: string, onText: (delta: string) => void, signal: AbortSignal): Promise<void>;
}

export interface LoopMetric {
  /** wakeToAck: wake recognised (orb pops) → « Yes, Master? » handed to the speaker (it waits for the end of the
   * sentence: parts.afterWakeSpeechEnd = from the end of « Hi Atlas »). speechEndToFirstWord: end of Master's
   * command → first reply sentence handed to the speaker (stt + model + tts). bargeIn: « Atlas » / stop word recognised → silence. */
  name: 'wakeToAck' | 'speechEndToFirstWord' | 'bargeIn';
  ms: number;
  /** speechEndToFirstWord's parts. */
  parts?: Record<string, number>;
}

export interface LoopOptions {
  models: VoiceModels;
  orb: OrbPort;
  chat: ChatPort;
  /** For « Yes, Master? » (« Yes? » while the name is not set). */
  userName: () => string;
  voice: () => VoiceName;
  sensitivity?: number;
  /** Silence that ends Master's sentence. */
  silenceSeconds?: number;
  /** After a reply (or a bare « Hi Atlas »): this long to speak again without the wake word, then back to rest. */
  followUpSeconds?: number;
  onMetric?: (m: LoopMetric) => void;
  /** Every state change (diagnostics). */
  onState?: (from: LoopState, to: LoopState) => void;
  /** Every utterance heard (see PipelineOptions.onHeard). */
  onHeard?: (text: string, outcome: string) => void;
  /** Errors (also shown on the orb). Default: console.error. */
  onError?: (e: Error) => void;
  /** announce(): wait for this much quiet (nobody talking) before speaking. */
  quietSeconds?: number;
  /** announce(): give up after waiting this long (never said; the reply stays written in the Voice chat). */
  holdSeconds?: number;
}

/**
 * Words of a barge-in that only means « be quiet »: an utterance made of these alone is not sent to the chat (« stop »,
 * « wait a second », « no no », « dur bir dakika », « sus artık », « tamam, yeter »).
 */
const QUIET = new Set(
  ('stop stopp wait no nope atlas quiet be shut up enough that thats that\'s it talking there cancel never mind nevermind forget ' +
    'thanks thank you okay ok hold on a second sec minute moment please ' +
    'dur duş düş hayır hayir bekle sus yeter artık artik tamam bir dakika saniye lütfen teşekkürler sağol sağ ol')
    .split(' '),
);
/** A follow-up (no barge-in) that only closes the exchange: not sent. « No » / « hayır » here may answer a question: sent. */
const STOP = /^\W*(?:stop(?: it| talking| there)?|quiet|be quiet|shut up|enough|that's enough|cancel|never ?mind|forget it|thanks|thank you|okay|ok)\W*$/i;

/**
 * Whether a barge-in only means « be quiet »: every word is a stop word (+ Whisper's « Душ », « СУС »), or the start of
 * the stop word right before it, repeated when the audio was cut (« Yeter. Y », « Hayyuz. Hayy »; #257). Any other
 * word makes it a command: « stop, go on », « dur, bak ».
 */
export function isQuiet(text: string): boolean {
  const words = text.toLocaleLowerCase('tr').match(/[\p{L}']+/gu) ?? [];
  const quiet = (w: string) => QUIET.has(w) || QUIET.has(w.toLowerCase()) || stopWord(w) !== undefined;
  return words.length > 0 && words.every((w, i) => quiet(w) || (i > 0 && isCutRepeat(w, words[i - 1]!) && quiet(words[i - 1]!)));
}

/** `w` is the beginning of `before` (the word said again, cut off by the end of the audio). */
function isCutRepeat(w: string, before: string): boolean {
  return w.length < before.length && before.startsWith(w);
}

/** How long a played sentence still counts as « just said » for the echo filter (room echo, VAD lag). */
const ECHO_MS = 2500;
/** Push-to-talk released: the microphone frames still in flight (~128 ms each) are waited for before sending. */
const HOLD_TAIL_MS = 250;

/**
 * The voice conversation: « Hi Atlas » → orb + « Yes, Master? » → Master's sentence → the Voice chat → the reply spoken
 * sentence by sentence while the caption types it → ~8 s to follow up without the wake word → rest.
 *
 * Barge-in: while Atlas thinks or speaks, the pipeline wakes on the name alone (« Atlas », « Atlas, stop ») or on an
 * utterance opening with a stop word (« stop », « wait », « no », « dur », « hayır », « bekle », « sus », « yeter »; card
 * #53): playback stops and it listens. A bare stop (« hayır », « wait a second ») is not sent; « No, I meant tomorrow »
 * is the new message. Esc or a click on the orb ends the conversation (escape(), dismissed()).
 * Not hearing itself: microphone echo cancellation first (the orb's getUserMedia), then three guards here: a barge-in
 * « Atlas » (or stop word) is ignored while the sentence being played (or just played) says it; Atlas's own « Yes, Master? » is stripped from a
 * command; the follow-up window starts with the speech detector cleared (the reply's echo tail is dropped).
 *
 * Voice state is not important state (CLAUDE.md rule 2): a restart starts at rest. The conversation is the Voice chat.
 */
export class VoiceLoop {
  private st: LoopState = 'idle';
  private readonly pipeline: VoicePipeline;
  /** Bumped by barge-in, Esc, dismiss: async work of an older turn stops where it is. */
  private turn = 0;
  private abort: AbortController | null = null;
  /** Sentences being played or played in the last ECHO_MS (their end time; Infinity while queued or playing). */
  private said = new Map<string, number>();
  private ack: { key: string; pcm: Promise<{ samples: Float32Array; sampleRate: number }> } | null = null;
  private readonly silence: number;
  private wokeAt = 0;
  /** announce()d replies waiting to be spoken (`at`: when they came). */
  private queue: { text: string; at: number }[] = [];
  private announcing = false;
  /** When someone was last heard talking (performance.now()). */
  private voiceAt = -Infinity;
  /** The coming command follows a barge-in: a bare stop word (isQuiet) is not sent. */
  private barged = false;

  constructor(private readonly opts: LoopOptions) {
    this.silence = opts.silenceSeconds ?? 0.8;
    this.pipeline = new VoicePipeline(opts.models, {
      onEvent: (e) => this.onEvent(e),
      sensitivity: opts.sensitivity,
      silenceSeconds: this.silence,
      commandTimeoutSeconds: opts.followUpSeconds ?? 8,
      acceptWake: (text) => this.acceptWake(text),
      onHeard: (text, outcome) => opts.onHeard?.(text, outcome),
    });
  }

  get state(): LoopState {
    return this.st;
  }

  /** Synthesizes « Yes, Master? » ahead of time, so the first wake answers at once. */
  async warm(): Promise<void> {
    await this.ackPcm();
  }

  /** The next frame of microphone audio (16 kHz mono float). */
  feed(samples: Float32Array): void {
    this.pipeline.feed(samples);
    // someone talking (not Atlas itself: its own playback's echo does not count)
    if (this.pipeline.hearing && (this.st === 'idle' || this.st === 'listening')) this.voiceAt = performance.now();
    if (this.queue.length) this.pump();
  }

  /**
   * A reply in the Voice chat that no spoken turn asked for (a card report, a message typed with the keyboard): said
   * aloud when Atlas is free (at rest or in the follow-up window) and nobody has talked for quietSeconds, then the
   * follow-up window. Queued behind a running turn; dropped after holdSeconds (Master on a call): it stays written in the chat.
   * Barge-in and Esc work as for any reply, and drop what is still queued. Card #52.
   */
  announce(text: string): void {
    this.queue.push({ text, at: performance.now() });
    this.pump();
  }

  /** Esc: ends the conversation (stops speaking and listening), back to rest. Master, 13 Nov 2026. */
  escape(): void {
    this.rest(true);
  }

  /** The orb was dismissed (Master clicked it): back to rest. */
  dismissed(): void {
    this.opts.onState?.(this.st, 'idle');
    this.rest(true);
  }

  /**
   * « Start talking » (menu bar orb, card #54): as a bare « Hi Atlas »: the orb wakes, « Yes, Master? », then the next
   * utterance is the command. While Atlas thinks or speaks: a barge-in. Already awake and listening: nothing to do.
   */
  wakeNow(): void {
    if (this.st === 'thinking' || this.st === 'speaking') {
      this.bargeIn();
      this.pipeline.startCapture();
      return;
    }
    if (this.st !== 'idle') return;
    this.pipeline.reset();
    this.pipeline.setWakeMode('phrase');
    this.wake('');
    this.pipeline.startCapture();
    void this.greet(performance.now());
  }

  /**
   * Push-to-talk held (hold ⌥, card #75): a walkie-talkie. Interrupts whatever Atlas is saying or thinking and records
   * everything until holdEnd() (no « Yes? »: Master is already talking, no silence timeout: they may pause).
   */
  holdStart(): void {
    if (this.st !== 'idle') this.interrupt();
    this.turn++;
    this.barged = false;
    this.pipeline.holdStart();
    this.pipeline.setWakeMode('phrase');
    if (this.st !== 'listening') this.set('listening');
  }

  /** Push-to-talk released: what was said is sent at once ('command'; nothing said: back to rest). */
  holdEnd(): void {
    if (!this.pipeline.holding) return;
    const turn = this.turn;
    setTimeout(() => turn === this.turn && this.pipeline.holdEnd(), HOLD_TAIL_MS);
  }

  /** Push-to-talk cancelled (another key or a click while ⌥ was held): nothing is sent, back to rest. */
  holdCancel(): void {
    if (this.pipeline.holding) this.rest(false);
  }

  /** Resolves when queued transcriptions are done (tests). */
  settled(): Promise<void> {
    return this.pipeline.settled();
  }

  private set(state: LoopState) {
    this.opts.onState?.(this.st, state);
    this.st = state;
    this.opts.orb.setState(state);
  }

  private onEvent(e: VoiceEvent) {
    switch (e.type) {
      case 'wake':
        if (this.st === 'thinking' || this.st === 'speaking') return this.bargeIn();
        return void this.wake(e.text);
      case 'awaiting':
        if (this.st === 'wake') void this.greet(performance.now() - e.sttMs - this.silence * 1000);
        return;
      case 'command': {
        const barged = this.barged;
        this.barged = false;
        // « Atlas, stop », « hayır », « wait a second »: the barge-in already silenced it
        if (barged ? isQuiet(e.text) : STOP.test(e.text)) return this.followUp();
        return void this.reply(e);
      }
      case 'timeout':
        if (this.st === 'listening' || this.st === 'wake') this.rest(false);
        return;
      case 'error':
        return this.fail(e.error);
    }
  }

  private acceptWake(text: string): boolean {
    if (this.pipeline.wakeMode === 'phrase') return true;
    // barge-in: « Atlas » or the stop word in what Atlas itself is saying (or just said) may be its own echo
    const word = /\b(?:atlas|atlus|adlas|aglas|atlass|attas)\b/i.test(text) ? undefined : stopWord(text)?.word;
    const now = performance.now();
    for (const [sentence, end] of this.said) {
      if (end + ECHO_MS < now) this.said.delete(sentence);
      else if (word ? saysStopWord(sentence, word) : /\bat ?l[au]s/i.test(sentence)) return false;
    }
    return true;
  }

  /**
   * The orb pops as soon as « Hi Atlas » is recognised (often mid-sentence: early wake). « Yes, Master? » waits for the
   * end of that sentence: a bare « Hi Atlas » gets it ('awaiting'); « Hi Atlas, what's… » goes straight to the answer,
   * never talked over.
   */
  private wake(_text: string) {
    ++this.turn;
    this.wokeAt = performance.now();
    this.set('wake');
  }

  /** `speechEnd`: when Master stopped saying « Hi Atlas » (performance.now() time). */
  private async greet(speechEnd: number) {
    const turn = this.turn;
    try {
      const { samples, sampleRate } = await this.ackPcm();
      if (turn !== this.turn || this.st !== 'wake') return;
      const now = performance.now();
      this.opts.onMetric?.({ name: 'wakeToAck', ms: now - this.wokeAt, parts: { afterWakeSpeechEnd: now - speechEnd } });
      this.said.set(this.ackText(), Infinity);
      await this.opts.orb.speak(this.ackText(), samples, sampleRate);
      this.said.set(this.ackText(), performance.now());
    } catch (e) {
      return this.fail(e);
    }
    this.listen(turn);
  }

  private listen(turn: number) {
    if (turn === this.turn && this.st === 'wake') this.set('listening');
  }

  private ackText() {
    const name = this.opts.userName();
    return name && name !== 'the user' ? `Yes, ${name}?` : 'Yes?';
  }

  private ackPcm() {
    const key = `${this.opts.voice()}|${this.ackText()}`;
    if (this.ack?.key !== key) {
      const pcm = this.opts.models.synthesize(this.ackText(), this.opts.voice());
      this.ack = { key, pcm };
      pcm.catch(() => this.ack?.pcm === pcm && (this.ack = null));
    }
    return this.ack.pcm;
  }

  /** Master's sentence → the Voice chat → the reply, spoken as it streams. */
  private async reply(cmd: Extract<VoiceEvent, { type: 'command' }>) {
    const ackEnd = this.said.get(this.ackText());
    const text = stripAck(cmd.text, this.opts.userName(), ackEnd !== undefined && ackEnd + ECHO_MS >= performance.now());
    if (!text) return this.pipeline.startCapture(); // only our own « Yes, Master? » came back: keep listening
    const tCmd = performance.now();
    const speechEnd = tCmd - cmd.sttMs - cmd.tailMs;
    const turn = ++this.turn;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.opts.orb.transcript(text);
    this.set('thinking');
    this.pipeline.setWakeMode('name'); // from now on « Atlas » alone, or a stop word, interrupts
    const stream = new SentenceStream();
    let tFirstText = 0;
    const speaker = this.speaker(turn, (tts) => {
      const now = performance.now();
      this.opts.onMetric?.({
        name: 'speechEndToFirstWord',
        ms: now - speechEnd,
        parts: { silence: Math.round(cmd.tailMs), stt: cmd.sttMs, firstSentence: tFirstText - tCmd, tts },
      });
    });
    const emit = (sentences: string[]) => {
      if (sentences.length && !tFirstText) tFirstText = performance.now();
      sentences.forEach(speaker.say);
    };
    try {
      await this.opts.chat.ask(text, (d) => emit(stream.push(d)), abort.signal);
      emit(stream.end());
      await speaker.done();
    } catch (e) {
      if (turn !== this.turn) return; // interrupted meanwhile: nothing to report
      this.fail(e);
      return;
    }
    if (turn !== this.turn) return;
    this.followUp();
  }

  /** Sentences → synthesized and played in order while `turn` is current. `onFirst(ttsMs)`: the first is handed over. */
  private speaker(turn: number, onFirst?: (ttsMs: number) => void) {
    let chain: Promise<void> = Promise.resolve();
    const played: Promise<boolean>[] = [];
    let first = true;
    return {
      say: (sentence: string) => {
        chain = chain.then(async () => {
          if (turn !== this.turn) return;
          this.said.set(sentence, Infinity);
          const t0 = performance.now();
          const { samples, sampleRate } = await this.opts.models.synthesize(sentence, this.opts.voice());
          if (turn !== this.turn) return;
          if (first) {
            first = false;
            onFirst?.(performance.now() - t0);
          }
          if (this.st !== 'speaking') this.set('speaking');
          played.push(this.opts.orb.speak(sentence, samples, sampleRate).finally(() => this.said.set(sentence, performance.now())));
        });
      },
      done: async () => {
        await chain;
        await Promise.all(played);
      },
    };
  }

  /** Speaks the next announce()d reply when Atlas is free and it is quiet; drops the ones held too long. */
  private pump() {
    if (!this.queue.length || this.announcing) return;
    if (this.st !== 'idle' && this.st !== 'listening') return; // a turn is under way: after it
    const now = performance.now();
    const hold = (this.opts.holdSeconds ?? 120) * 1000;
    // no quiet for that long (a call, a meeting): not said at all, it stays written in the Voice chat (Master, 14 Nov)
    this.queue = this.queue.filter((q) => now - q.at <= hold);
    if (!this.queue.length) return;
    if (this.pipeline.hearing || now - this.voiceAt < (this.opts.quietSeconds ?? 3) * 1000) return;
    void this.speakAnnouncement(this.queue.shift()!.text);
  }

  private async speakAnnouncement(text: string) {
    const stream = new SentenceStream();
    const sentences = [...stream.push(text), ...stream.end()];
    if (!sentences.length) return this.pump(); // only code: nothing to say
    const turn = ++this.turn;
    this.announcing = true;
    this.abort?.abort();
    this.abort = null;
    this.pipeline.reset(); // not a follow-up command while it speaks; « Atlas » alone interrupts
    this.pipeline.setWakeMode('name');
    const speaker = this.speaker(turn);
    try {
      sentences.forEach(speaker.say);
      await speaker.done();
    } catch (e) {
      if (turn === this.turn) this.fail(e);
      return;
    } finally {
      this.announcing = false;
    }
    if (turn !== this.turn) return;
    this.followUp();
  }

  /** Barge-in: « Atlas » or a stop word while Atlas thinks or speaks. The pipeline already takes what follows as the command. */
  private bargeIn() {
    const t0 = performance.now();
    this.interrupt();
    this.barged = true;
    this.set('listening');
    this.opts.onMetric?.({ name: 'bargeIn', ms: performance.now() - t0 });
  }

  private interrupt() {
    this.queue = []; // Master wants to talk: what was waiting stays in the Voice chat
    this.turn++;
    this.abort?.abort();
    this.abort = null;
    this.opts.orb.hush();
    this.pipeline.setWakeMode('phrase');
  }

  /** Listening without the wake word, for followUpSeconds; then rest (the pipeline's timeout). */
  private followUp() {
    this.pipeline.reset(); // drop what the microphone caught of the reply
    this.pipeline.setWakeMode('phrase');
    this.pipeline.startCapture();
    this.set('listening');
    this.pump(); // a reply queued during this turn (otherwise the next microphone frame does it)
  }

  /** `drop`: Master ended the conversation (Esc, orb click): replies still waiting are not read aloud either. */
  private rest(drop: boolean) {
    if (drop) this.queue = [];
    this.barged = false;
    this.turn++;
    this.abort?.abort();
    this.abort = null;
    this.pipeline.reset();
    this.pipeline.setWakeMode('phrase');
    if (this.st !== 'idle') this.set('idle');
  }

  private fail(e: unknown) {
    const err = e instanceof Error ? e : new Error(String(e));
    this.turn++;
    this.abort?.abort();
    this.abort = null;
    // stay awake with the error in the caption; the follow-up window then puts the orb to rest
    this.followUp();
    this.opts.orb.error(err.message);
    if (this.opts.onError) this.opts.onError(err);
    else console.error('[voice]', err);
  }
}

/** Removes Atlas's own « Yes, Master? » (heard back through the speakers) from a command. */
export function stripAck(text: string, userName: string, ackJustSaid = false): string {
  const name = userName && userName !== 'the user' ? userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : 'master';
  const rest = text.replace(new RegExp(`^\\W*yes\\W+(?:${name}|master)\\b\\W*`, 'i'), '').trim();
  // the ack was just spoken: a short « yes … » is its echo misheard (« Yesta. », « Yes must », « Yes, Moss. »; #257).
  // Later, « yes » is Master's answer: sent.
  return ackJustSaid && isAckEcho(rest) ? '' : rest;
}

/** At most 2 words, the first starting with « yes », none longer than 7 letters (« yes do it »: 3 words, a command). */
function isAckEcho(text: string): boolean {
  const words = text.match(/[\p{L}']+/gu) ?? [];
  return words.length > 0 && words.length <= 2 && /^yes/i.test(words[0]!) && words.every((w) => w.length <= 7);
}

/**
 * Reply text as it streams → whole sentences, as soon as each is complete (the next one has started). Code blocks are
 * held back until closed (then dropped by splitSentences, never read aloud).
 */
export class SentenceStream {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    let cut = 0;
    for (const m of this.buf.matchAll(/[.!?…]\s+(?=[\p{Lu}\d"'(])|\n+/gu)) cut = m.index + m[0].length;
    let done = this.buf.slice(0, cut);
    const fences = done.split('```').length - 1;
    if (fences % 2) done = done.slice(0, done.lastIndexOf('```'));
    if (!done) return [];
    this.buf = this.buf.slice(done.length);
    return splitSentences(done);
  }

  end(): string[] {
    const rest = this.buf;
    this.buf = '';
    return splitSentences(rest);
  }
}
