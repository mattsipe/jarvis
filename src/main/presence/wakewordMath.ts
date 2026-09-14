/**
 * Pure math for the openWakeWord pipeline — no ONNX/Electron imports, so
 * it's directly unit-testable. wakeword.ts does the actual (impure, async)
 * model inference and imports this for the parts that are just arithmetic.
 */

/** Porcupine-style 0-1 "sensitivity" -> openWakeWord's 0-1 raw classifier-score threshold. Higher sensitivity = lower threshold = triggers more easily — same direction/semantics Presence's config already exposed under the previous engine. */
export function sensitivityToThreshold(sensitivity: number): number {
  const s = Math.max(0, Math.min(1, sensitivity))
  return 0.8 - 0.6 * s
}

/**
 * The false-positive-protection gate: only report a wake once the score has
 * been at/above threshold for `required` consecutive frames in a row (each
 * frame is 80ms), not on a single lucky frame. Pure so the debounce logic
 * itself — not just the threshold math — is covered by a test without
 * needing a real model.
 */
export class ConsecutiveFrameGate {
  private count = 0
  constructor(private required: number) {}

  /** Live-editable — the Presence panel can change this without recreating the engine. */
  setRequired(required: number): void {
    this.required = Math.max(1, Math.round(required))
  }

  /** Feed one frame's score; returns true the instant `required` consecutive frames have cleared the threshold. */
  observe(score: number, threshold: number): boolean {
    this.count = score >= threshold ? this.count + 1 : 0
    return this.count >= this.required
  }

  reset(): void {
    this.count = 0
  }
}

/**
 * Rolling max of the last `windowSize` scores — powers the Presence
 * panel's "recent peak score" diagnostic, so "is the model hearing
 * anything at all, just not enough" is visible without needing to add
 * real logging/tracing to debug a live report. Pure ring buffer, no
 * timestamps needed: at one 80ms frame per push, a 60-frame window is
 * ~4.8 seconds of history.
 */
export class RollingPeak {
  private readonly buffer: number[]
  private index = 0
  private filled = false

  constructor(private readonly windowSize: number) {
    this.buffer = new Array(windowSize).fill(0)
  }

  push(value: number): void {
    this.buffer[this.index] = value
    this.index = (this.index + 1) % this.windowSize
    if (this.index === 0) this.filled = true
  }

  peak(): number {
    const len = this.filled ? this.windowSize : this.index
    let max = 0
    for (let i = 0; i < len; i++) if (this.buffer[i] > max) max = this.buffer[i]
    return max
  }

  reset(): void {
    this.buffer.fill(0)
    this.index = 0
    this.filled = false
  }
}
