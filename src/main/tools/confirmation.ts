import { randomUUID } from 'crypto'
import { broadcast } from '../window'

export interface PendingConfirmation {
  id: string
  toolName: string
  description: string
}

const CONFIRMATION_TIMEOUT_MS = 20000

interface Pending {
  info: PendingConfirmation
  resolve: (approved: boolean) => void
  timeout: ReturnType<typeof setTimeout>
}

let pending: Pending | null = null

const YES_WORDS = /\b(yes|yeah|yep|confirm|confirmed|do it|go ahead|proceed|approve|approved)\b/i
const NO_WORDS = /\b(no|nope|cancel|stop|don't|do not|deny|denied|abort)\b/i

/**
 * Elevated-risk tools (e.g. close_app) block here until Weston explicitly
 * approves — by clicking Approve/Deny in either HUD surface, or by saying
 * a yes/no word while the confirmation is pending (see
 * VoiceSession.tryResolvePendingConfirmation). Auto-denies on timeout so a
 * destructive action never just hangs waiting forever, and never silently
 * executes either.
 */
export function requestConfirmation(toolName: string, description: string): Promise<boolean> {
  return new Promise((resolve) => {
    const info: PendingConfirmation = { id: randomUUID(), toolName, description }
    const timeout = setTimeout(() => {
      if (pending?.info.id === info.id) {
        pending = null
        broadcast('tool:confirm-resolved', { id: info.id, approved: false, reason: 'timeout' })
      }
      resolve(false)
    }, CONFIRMATION_TIMEOUT_MS)
    pending = { info, resolve, timeout }
    broadcast('tool:confirm-request', info)
  })
}

/** Called from IPC when a HUD click resolves the confirmation. */
export function resolveConfirmation(id: string, approved: boolean): void {
  if (!pending || pending.info.id !== id) return
  clearTimeout(pending.timeout)
  const { resolve, info } = pending
  pending = null
  resolve(approved)
  broadcast('tool:confirm-resolved', { id: info.id, approved, reason: 'response' })
}

/** Called from VoiceSession with each final transcript while a confirmation is outstanding. */
export function tryResolveConfirmationFromSpeech(text: string): boolean {
  if (!pending) return false
  if (YES_WORDS.test(text)) {
    resolveConfirmation(pending.info.id, true)
    return true
  }
  if (NO_WORDS.test(text)) {
    resolveConfirmation(pending.info.id, false)
    return true
  }
  return false
}

export function hasPendingConfirmation(): boolean {
  return pending !== null
}
