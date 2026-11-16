import type { OrbState, Point } from './model.ts';

/** Main process → orb page (IPC channel 'orb'). Points are relative to the overlay window. */
export type ToOrb =
  | { type: 'init'; pos: Point }
  | { type: 'state'; state: OrbState }
  /** Live transcript while listening (replaces the previous one). */
  | { type: 'transcript'; text: string }
  /** One reply sentence to play; its text is typed while it plays. The page answers 'spoken' with the same id. */
  | { type: 'speak'; id: number; text: string; samples: Float32Array; sampleRate: number }
  | { type: 'visible'; visible: boolean }
  /** Barge-in: stop playing now, stay awake. */
  | { type: 'hush' }
  /** A voice loop error to show in the caption. */
  | { type: 'error'; message: string }
  /**
   * The voice loop wants the microphone open (wake word listening, a conversation) or closed (wake word off, at rest:
   * card #57). Kept while hidden: showing the orb opens it only if wanted.
   */
  | { type: 'mic'; on: boolean };

/** Orb page → main process (IPC channel 'orb:event'). */
export type FromOrb =
  /** The mouse is over the orb (take clicks) or not (let them through to the app below). */
  | { type: 'hit'; on: boolean }
  | { type: 'moved'; pos: Point }
  /** A click on the awake orb (not a drag): end the conversation, back to rest. */
  | { type: 'dismiss' }
  /** Esc: rest, or while Atlas speaks, stop and listen (the voice loop decides). */
  | { type: 'escape' }
  /** Every change of the orb's place on the page, with why (diagnostics: logs/voice.log). */
  | { type: 'trace'; line: string }
  /** Microphone audio, 16 kHz mono float, ~128 ms per frame, while the orb is shown (wake word listening). */
  | { type: 'audio'; samples: Float32Array }
  | { type: 'spoken'; id: number }
  /** Microphone or audio output failed: shown on the orb and reported (fail loudly). */
  | { type: 'error'; message: string };

export interface OrbBridge {
  on(listener: (msg: ToOrb) => void): void;
  send(msg: FromOrb): void;
}
