import { VoiceSession } from './session'
import { broadcast, getOverlayWindow } from '../window'
import { presence } from '../presence'

/**
 * Single owner of "is there a live conversation right now" — extracted out
 * of ipc.ts so both the hotkey/IPC path and the wake-word path (see
 * presence/index.ts, wired via registerSessionControls in main/index.ts)
 * go through the exact same start/end logic and can never end up with two
 * VoiceSession instances at once. presence.ts is notified on both edges so
 * its state (and the renderer's presence-mic capture) stays in sync with
 * whichever trigger actually started/ended the conversation.
 */
let session: VoiceSession | null = null
let sessionActive = false

export function isSessionActive(): boolean {
  return sessionActive
}

/** The live VoiceSession instance, if any — for ipc.ts's per-event pass-through calls (audio chunks, playback timing, barge-in). */
export function getCurrentSession(): VoiceSession | null {
  return session
}

function start(): void {
  const win = getOverlayWindow()
  if (!win || sessionActive) return
  sessionActive = true
  presence.notifySessionStarted()
  session = new VoiceSession(() => {
    sessionActive = false
    session = null
    presence.notifySessionEnded()
    broadcast('voice:toggle', { listening: false })
  })
  broadcast('voice:toggle', { listening: true })
}

function end(): void {
  if (!sessionActive) return
  session?.endSession() // terminate() -> the onEnded callback above clears sessionActive/session and notifies presence
}

/** Global hotkey / Command Center button — first call starts, second call ends, regardless of phase. */
export function toggleSession(): void {
  if (sessionActive) end()
  else start()
}

/** Wake-word trigger — a no-op if a session is somehow already active, rather than toggling it off. */
export function startSession(): void {
  start()
}

export function endSession(): void {
  end()
}
