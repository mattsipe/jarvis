export type TransportState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error' | 'closed'

/**
 * Live diagnostics for one streaming voice transport — broadcast to the
 * renderer's Voice Transport panel (see session.ts) so a "random
 * WebSocket error" report can point at exactly which provider, and
 * whether JARVIS already recovered from it, instead of a single generic
 * error banner.
 */
export interface TransportStatus {
  provider: 'deepgram' | 'elevenlabs'
  state: TransportState
  retryCount: number
  lastError: string | null
  updatedAt: number
}
