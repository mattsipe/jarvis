import { app } from 'electron'
import { logInfo } from '../logger'
import { broadcast, showCommandCenter, setTrayStatus } from '../window'
import { wakeWordEngine } from './wakeword'
import { FrameBuffer } from './frameBuffer'
import { getPresenceConfig, updatePresenceConfig } from './config'
import { computeState, type PresenceState } from './state'

export type { PresenceState } from './state'

export interface PresenceStatus {
  state: PresenceState
  enabled: boolean
  launchAtLogin: boolean
  muted: boolean
  wakeEngineReady: boolean
  wakeEngineError: string | null
  /** Whether the renderer's presence mic capture should be running right now — the UI/renderer derives its own capture lifecycle from this rather than duplicating the state precedence rules. */
  micActive: boolean
  /** Whether a real conversation (Deepgram/Claude/ElevenLabs) is in progress. */
  cloudAudioActive: boolean
  wakeCount: number
  lastWakeAt: string | null
}

function trayLabel(state: PresenceState, engineError: string | null): string {
  switch (state) {
    case 'sleeping':
      return 'Listening for "Jarvis"'
    case 'active':
      return 'In conversation'
    case 'muted':
      return 'Muted'
    case 'disabled':
      return engineError ? 'Presence off (wake-word engine failed)' : 'Presence off (hotkey only)'
  }
}

function applyLoginItemSettings(launchAtLogin: boolean): void {
  if (process.platform === 'linux') return // setLoginItemSettings is unreliable/no-op across Linux desktop environments — skip rather than silently misreport it as applied
  app.setLoginItemSettings({ openAtLogin: launchAtLogin, args: launchAtLogin ? ['--hidden'] : [] })
}

/**
 * Owns the wake-word layer end to end: the engine, the state precedence
 * above, and the audio buffering that turns renderer-sent PCM chunks into
 * engine-sized frames. Deliberately has NO import of voice/session.ts or
 * voice/sessionManager.ts — starting/ending a conversation is injected via
 * registerSessionControls() from main/index.ts (the composition root), so
 * presence -> session and session -> presence stay one-directional each
 * and never form an import cycle.
 *
 * The engine (wakeword.ts) runs real ONNX inference per frame, which is
 * async — audio chunks are queued and drained strictly in order rather
 * than processed inline, so a chunk arriving mid-inference can never race
 * the frame buffer or the engine's own internal streaming state.
 */
class PresenceCoordinator {
  private state: PresenceState = 'disabled'
  private muted = false
  private sessionActive = false
  private frameBuffer: FrameBuffer | null = null
  private wakeCount = 0
  private lastWakeAt: string | null = null
  private startSessionFn: (() => void) | null = null
  private endSessionFn: (() => void) | null = null
  private pendingChunks: ArrayBuffer[] = []
  private draining = false

  registerSessionControls(controls: { start: () => void; end: () => void }): void {
    this.startSessionFn = controls.start
    this.endSessionFn = controls.end
  }

  /** Called once at app startup. Safe even if the engine fails to load (a corrupted install, missing resource files, etc.) — it just reports not-ready and Presence settles into 'disabled', falling back to the hotkey. */
  async start(): Promise<void> {
    applyLoginItemSettings(getPresenceConfig().launchAtLogin)
    const engineStatus = await wakeWordEngine.start()
    this.frameBuffer = engineStatus.ready && engineStatus.frameLength ? new FrameBuffer(engineStatus.frameLength) : null
    this.recompute()
  }

  /** Command Center's Presence panel "Retry" button, for the rare case the engine failed to load (e.g. a corrupted install) — nothing else needs a user-triggered retry since there's no key/account to add anymore. */
  async retryEngine(): Promise<void> {
    if (wakeWordEngine.status().ready) return
    await this.start()
  }

  stop(): void {
    wakeWordEngine.stop()
    this.frameBuffer = null
    this.pendingChunks = []
    this.recompute()
  }

  setEnabled(enabled: boolean): void {
    updatePresenceConfig({ enabled })
    this.recompute()
  }

  setLaunchAtLogin(launchAtLogin: boolean): void {
    updatePresenceConfig({ launchAtLogin })
    applyLoginItemSettings(launchAtLogin)
    this.recompute() // no state-precedence change, but status() should reflect it immediately
  }

  setMuted(muted: boolean): void {
    if (this.muted === muted) return
    this.muted = muted
    if (muted) {
      this.discardPendingAudio()
      if (this.sessionActive) this.endSessionFn?.()
    }
    this.recompute()
  }

  toggleMuted(): void {
    this.setMuted(!this.muted)
  }

  /** Called by voice/sessionManager.ts right before/after a session starts, from any trigger (hotkey or wake word). */
  notifySessionStarted(): void {
    this.sessionActive = true
    this.discardPendingAudio()
    this.recompute()
  }

  notifySessionEnded(): void {
    this.sessionActive = false
    this.recompute()
  }

  /** Fed continuously from the renderer's presence mic capture — see preload's onPresenceState/sendPresenceAudioChunk and audio/presenceCapture.ts. Queued and drained in order rather than processed inline, since the engine's inference is async — see the class comment. */
  ingestAudioChunk(chunk: ArrayBuffer): void {
    if (this.state !== 'sleeping' || !this.frameBuffer) return
    this.pendingChunks.push(chunk)
    void this.drainPending()
  }

  private discardPendingAudio(): void {
    this.pendingChunks = []
    this.frameBuffer?.reset()
    wakeWordEngine.reset()
  }

  private async drainPending(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.pendingChunks.length > 0) {
        if (this.state !== 'sleeping' || !this.frameBuffer) {
          this.pendingChunks = []
          break
        }
        const chunk = this.pendingChunks.shift()!
        const frames = this.frameBuffer.push(new Int16Array(chunk))
        for (const frame of frames) {
          if (this.state !== 'sleeping') break
          const detected = await wakeWordEngine.processFrame(frame)
          if (detected) {
            this.handleWake()
            this.pendingChunks = []
            break
          }
        }
      }
    } finally {
      this.draining = false
    }
  }

  private handleWake(): void {
    if (this.state !== 'sleeping') return
    this.wakeCount++
    this.lastWakeAt = new Date().toISOString()
    logInfo('presence', `wake word detected (#${this.wakeCount})`)
    this.discardPendingAudio()
    this.sessionActive = true // optimistic — notifySessionStarted() (called from sessionManager a moment later) confirms it; keeps ingestAudioChunk from re-triggering in between
    this.recompute()
    showCommandCenter()
    this.startSessionFn?.()
  }

  status(): PresenceStatus {
    const cfg = getPresenceConfig()
    const engineStatus = wakeWordEngine.status()
    return {
      state: this.state,
      enabled: cfg.enabled,
      launchAtLogin: cfg.launchAtLogin,
      muted: this.muted,
      wakeEngineReady: engineStatus.ready,
      wakeEngineError: engineStatus.error,
      micActive: this.state === 'sleeping',
      cloudAudioActive: this.sessionActive,
      wakeCount: this.wakeCount,
      lastWakeAt: this.lastWakeAt
    }
  }

  private recompute(): void {
    const cfg = getPresenceConfig()
    const next = computeState({ muted: this.muted, enabled: cfg.enabled, engineReady: wakeWordEngine.status().ready, sessionActive: this.sessionActive })
    const changed = next !== this.state
    this.state = next
    if (changed) logInfo('presence', `state -> ${next}`)
    const status = this.status()
    broadcast('presence:state', status)
    setTrayStatus(trayLabel(status.state, status.wakeEngineError), status.muted)
  }
}

export const presence = new PresenceCoordinator()
