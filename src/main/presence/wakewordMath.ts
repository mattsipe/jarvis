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
  constructor(private readonly required: number) {}

  /** Feed one frame's score; returns true the instant `required` consecutive frames have cleared the threshold. */
  observe(score: number, threshold: number): boolean {
    this.count = score >= threshold ? this.count + 1 : 0
    return this.count >= this.required
  }

  reset(): void {
    this.count = 0
  }
}
