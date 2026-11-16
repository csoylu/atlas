// Minimal types for the parts of sherpa-onnx-node (plain JS, JSDoc only) that Atlas voice uses.
declare module 'sherpa-onnx-node' {
  export interface Wave {
    samples: Float32Array;
    sampleRate: number;
  }
  export interface OnlineStream {
    acceptWaveform(wave: Wave): void;
    inputFinished(): void;
  }
  export interface KeywordResult {
    keyword: string;
    start_time: number;
    timestamps: number[];
    tokens: string[];
  }
  export class KeywordSpotter {
    constructor(config: object);
    createStream(): OnlineStream;
    isReady(stream: OnlineStream): boolean;
    decode(stream: OnlineStream): void;
    reset(stream: OnlineStream): void;
    getResult(stream: OnlineStream): KeywordResult;
  }
  export class Vad {
    constructor(config: object, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    front(enableExternalBuffer?: boolean): { start: number; samples: Float32Array };
    reset(): void;
    flush(): void;
  }
  export interface OfflineStream {
    acceptWaveform(wave: Wave): void;
  }
  export class OfflineRecognizer {
    static createAsync(config: object): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<{ text: string; lang?: string }>;
    setConfig(config: object): void;
  }
  export class OfflineTts {
    static createAsync(config: object): Promise<OfflineTts>;
    readonly sampleRate: number;
    readonly numSpeakers: number;
    generateAsync(request: { text: string; sid?: number; speed?: number; generationConfig?: GenerationConfig; enableExternalBuffer?: boolean }): Promise<Wave>;
  }
  export class GenerationConfig {
    constructor(config: { sid?: number; speed?: number; numSteps?: number; extra?: Record<string, string | number> });
  }
  export function readWave(path: string, enableExternalBuffer?: boolean): Wave;
  export function writeWave(path: string, wave: Wave): boolean;
  export const version: string;
}
