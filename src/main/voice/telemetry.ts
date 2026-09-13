const STAGE_ORDER = [
  'speechEnd',
  'sttFinal',
  'claudeRequest',
  'claudeFirstToken',
  'firstSpeakablePhrase',
  'ttsRequest',
  'firstTtsAudio',
  'playbackStart'
] as const

export type TurnStage = (typeof STAGE_ORDER)[number]

let turnCounter = 0

/**
 * Per-turn latency instrumentation — see the plan's API-safeguards
 * priority: "measurements first", not optimization. Marks are timestamped
 * once each (first call wins) and reported as the deltas between
 * consecutive stages, so the report reads as a waterfall from the moment
 * the user stopped talking to the moment audio actually started playing.
 */
export class TurnTimer {
  readonly turnNumber = ++turnCounter
  private marks = new Map<TurnStage, number>()

  mark(stage: TurnStage): void {
    if (!this.marks.has(stage)) this.marks.set(stage, Date.now())
  }

  /** Logs the waterfall to the console — dev diagnostics only, see the plan's Priority 3. */
  report(): void {
    const present = STAGE_ORDER.filter((s) => this.marks.has(s))
    if (present.length < 2) return
    const segments: string[] = []
    for (let i = 1; i < present.length; i++) {
      const a = present[i - 1]
      const b = present[i]
      segments.push(`${a}→${b} ${this.marks.get(b)! - this.marks.get(a)!}ms`)
    }
    const total = this.marks.get(present[present.length - 1])! - this.marks.get(present[0])!
    console.log(`[jarvis][latency] turn#${this.turnNumber}  ${segments.join('  |  ')}  ||  TOTAL ${total}ms`)
  }

  /** For the Command Center's diagnostics panel — same data as report(), structured. */
  snapshot(): { turnNumber: number; marks: Partial<Record<TurnStage, number>>; totalMs: number | null } {
    const present = STAGE_ORDER.filter((s) => this.marks.has(s))
    const marks: Partial<Record<TurnStage, number>> = {}
    for (const s of present) marks[s] = this.marks.get(s)!
    const totalMs =
      present.length >= 2 ? this.marks.get(present[present.length - 1])! - this.marks.get(present[0])! : null
    return { turnNumber: this.turnNumber, marks, totalMs }
  }
}
