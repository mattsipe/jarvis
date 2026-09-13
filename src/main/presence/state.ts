/**
 * Presence's state precedence — pure, no imports, so it's directly unit
 * testable without pulling in Electron (index.ts's coordinator imports
 * this rather than the other way around). Muted always wins (mic fully
 * off beats everything else); an active session beats idle wake-word
 * listening; anything short of "enabled + engine ready" collapses to
 * disabled (hotkey-only fallback), which is also where a missing/invalid
 * Picovoice AccessKey lands.
 */
export type PresenceState = 'disabled' | 'sleeping' | 'muted' | 'active'

export function computeState(input: { muted: boolean; enabled: boolean; engineReady: boolean; sessionActive: boolean }): PresenceState {
  if (input.muted) return 'muted'
  if (input.sessionActive) return 'active'
  if (!input.enabled || !input.engineReady) return 'disabled'
  return 'sleeping'
}
