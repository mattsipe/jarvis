/**
 * Pure PCM16 frame slicer — no Electron/native-module imports, so it's
 * unit-testable directly. Porcupine's `process()` requires exactly
 * `frameLength` Int16 samples per call, but the renderer's mic capture
 * sends whatever-sized chunks its own audio callback produces (see
 * audio/presenceCapture.ts) — this accumulates those chunks and hands back
 * complete frames plus whatever partial remainder to carry into the next
 * chunk, so no sample is ever dropped or duplicated across chunk
 * boundaries.
 */
export class FrameBuffer {
  private pending: Int16Array

  constructor(private readonly frameLength: number) {
    this.pending = new Int16Array(0)
  }

  /** Appends `chunk` and returns every complete frameLength-sized frame now available, in order. Leftover samples are kept for the next call. */
  push(chunk: Int16Array): Int16Array[] {
    const merged = new Int16Array(this.pending.length + chunk.length)
    merged.set(this.pending)
    merged.set(chunk, this.pending.length)

    const frames: Int16Array[] = []
    let offset = 0
    while (merged.length - offset >= this.frameLength) {
      frames.push(merged.slice(offset, offset + this.frameLength))
      offset += this.frameLength
    }
    this.pending = merged.slice(offset)
    return frames
  }

  /** Discards any partial frame — called when switching out of wake-word listening, so stale audio never leaks into the next listening period. */
  reset(): void {
    this.pending = new Int16Array(0)
  }
}
