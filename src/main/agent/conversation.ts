/**
 * Bounded rolling short-term conversation state for the optimized engine —
 * replaces loopLegacy.ts's unbounded, never-cleared module-level history.
 * See the Cost + Context Optimization plan's conversation-compression
 * design. Two layers:
 *  - a small rolling window of recent turn pairs, evicted by count AND by
 *    an estimated token size so it can't grow unbounded even with long
 *    replies;
 *  - a compact session summary that absorbs evicted turns (folded by
 *    agent/summarizer.ts, called by the loop after a turn finishes
 *    speaking — never blocking a reply).
 * OperateContext (operate/context.ts) is deliberately separate — it's
 * reset per voice session, this is not (short-term continuity should
 * survive the gap between one-shot-wake style commands), but both are
 * time-bounded so neither leaks across an idle gap.
 * No Electron imports — `now` is injectable for direct unit testing.
 */

export interface TurnPair {
  userText: string
  /** May already include an appended action digest — see buildDigest(). */
  assistantText: string
  /** Kept separately too, so a caller can decide whether to re-append it (e.g. after truncating assistantText). */
  digest: string
  at: number
}

export interface DigestEntry {
  tool: string
  ok: boolean
  note?: string
}

const MAX_WINDOW_PAIRS = 6
const MAX_WINDOW_TOKENS = 2500
const MAX_ASSISTANT_TEXT_CHARS = 400
const MAX_DIGEST_CHARS = 160
const IDLE_TTL_MS = 10 * 60 * 1000

/** Rough chars-per-token estimate for budgeting the window before a real API count exists — see the plan's "estimated as chars/3.5" note. */
export function estimateTokensForText(text: string): number {
  return Math.ceil(text.length / 3.5)
}

export function truncateAssistantText(text: string, max = MAX_ASSISTANT_TEXT_CHARS): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/** Compact, deterministic per-turn action summary — never built from raw tool transcripts, only from each tool's own (ok, note) outcome. This is what lets "what did you just do?" and "open the other one" work without replaying tool I/O. */
export function buildDigest(entries: DigestEntry[], maxChars = MAX_DIGEST_CHARS): string {
  if (entries.length === 0) return ''
  const parts = entries.map((e) => `${e.tool}${e.note ? ` ${e.note}` : ''} → ${e.ok ? 'ok' : 'failed'}`)
  let text = `[did: ${parts.join('; ')}]`
  if (text.length > maxChars) text = text.slice(0, maxChars - 2) + '…]'
  return text
}

function windowTokens(pairs: TurnPair[]): number {
  return pairs.reduce((sum, p) => sum + estimateTokensForText(p.userText) + estimateTokensForText(p.assistantText), 0)
}

export class ConversationStore {
  private window: TurnPair[] = []
  private summary = ''
  private lastTurnAt = 0

  constructor(private readonly now: () => number = Date.now) {}

  private expireIfIdle(): void {
    if (this.window.length === 0 && !this.summary) return
    if (this.lastTurnAt && this.now() - this.lastTurnAt > IDLE_TTL_MS) {
      this.window = []
      this.summary = ''
    }
  }

  getWindow(): TurnPair[] {
    this.expireIfIdle()
    return [...this.window]
  }

  getSummary(): string {
    this.expireIfIdle()
    return this.summary
  }

  /** Appends one completed turn to the window, evicting the oldest pairs (by count, then by estimated token size) until both bounds are satisfied. Returns the evicted pairs so the caller can fold them into the summary. */
  recordTurn(pair: { userText: string; assistantText: string; digest: string }): { evicted: TurnPair[] } {
    this.expireIfIdle()
    this.window.push({ ...pair, at: this.now() })
    this.lastTurnAt = this.now()

    const evicted: TurnPair[] = []
    while (this.window.length > MAX_WINDOW_PAIRS || windowTokens(this.window) > MAX_WINDOW_TOKENS) {
      const dropped = this.window.shift()
      if (!dropped) break
      evicted.push(dropped)
    }
    return { evicted }
  }

  applySummary(newSummary: string): void {
    this.summary = newSummary
  }

  reset(): void {
    this.window = []
    this.summary = ''
    this.lastTurnAt = 0
  }
}

/** One shared instance for the app's lifetime — see agent/loopOptimized.ts. Not reset on session end (unlike operateContext) so short references survive the gap between one-shot-wake style commands; it self-clears after IDLE_TTL_MS of inactivity instead. */
export const conversationStore = new ConversationStore()
