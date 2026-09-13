import { EventEmitter } from 'events'

export interface TranscriptEvent {
  text: string
  isFinal: boolean
  /** True when the provider detected a real pause (end of utterance), not just a finalized word chunk. */
  speechFinal: boolean
}

/**
 * Common streaming STT provider interface — Deepgram is the default
 * (deepgram.ts); whisper.cpp is the planned offline fallback (not yet
 * implemented, see voice/stt/index.ts).
 */
export declare interface SttProvider {
  on(event: 'transcript', listener: (e: TranscriptEvent) => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'closed', listener: () => void): this
}

export abstract class SttProvider extends EventEmitter {
  abstract start(sampleRate: number): void
  abstract sendAudio(chunk: Buffer): void
  abstract stop(): void
}
