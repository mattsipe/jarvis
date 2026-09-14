/**
 * Exponential backoff with full jitter (AWS's recommended shape: a
 * random delay between 0 and the exponential cap, not a fixed delay ±
 * jitter) — used by both streaming voice transports (deepgram.ts,
 * elevenlabs.ts) to avoid a reconnect storm if a provider has a brief
 * regional outage, and so a fast retry-then-fail doesn't look identical
 * to a hung connection.
 */
export function backoffDelayMs(attempt: number, baseMs = 300, capMs = 8000): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  return Math.round(Math.random() * exp)
}
