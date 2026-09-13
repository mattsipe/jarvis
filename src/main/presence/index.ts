import { app } from 'electron'
import { config } from '../config'
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
  accessKeyConfigured: boolean
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
      return engineError ? 'Presence off (no wake-word key)' : 'Presence off (hotkey only)'
  }
}

function applyLoginItemSettings(launchAtLogin: boolean): void {
  if (process.platform === 'linux') return // setLoginItemSettings is unreliable/no-op across Linux desktop environments — skip rather than silently misreport it as applied
  app.setLoginItemSettings({ openAtLogin: launchAtLogin, args: launchAtLogin ? ['--hidden'] : [] })
}

/**
 * Owns the wake-word layer end to end: the engine, the state precedence
 * above, and the audio buffering that turns renderer-sent PCM chunks into
 * Porcupine-sized frames. Deliberately has NO import of voice/session.ts
 * or voice/sessionManager.ts — starting/ending a conversation is injected
 * via registerSessionControls() from main/index.ts (the composition root),
 * so presence -> session and session -> presence stay one-directional
 * each and never form an import cycle.
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

  registerSessionControls(controls: { start: () => void; end: () => void }): void {
    this.startSessionFn = controls.start
    this.endSessionFn = controls.end
  }

  /** Called once at app startup. Safe to call even with no AccessKey configured — the engine just reports not-ready and Presence settles into 'disabled'. */
  start(): void {
    applyLoginItemSettings(getPresenceConfig().launchAtLogin)
    const engineStatus = wakeWordEngine.start()
    this.frameBuffer = engineStatus.ready && engineStatus.frameLength ? new FrameBuffer(engineStatus.frameLength) : null
    this.recompute()
  }

  /** Called after the AccessKey is saved from Command Center, so Presence can pick it up without an app restart. */
  refreshEngine(): void {
    if (wakeWordEngine.status().ready) return
    this.start()
  }

  stop(): void {
    wakeWordEngine.stop()
    this.frameBuffer = null
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
      this.frameBuffer?.reset()
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
    this.frameBuffer?.reset()
    this.recompute()
  }

  notifySessionEnded(): void {
    this.sessionActive = false
    this.recompute()
  }

  /** Fed continuously from the renderer's presence mic capture — see preload's onPresenceState/sendPresenceAudioChunk and audio/presenceCapture.ts. Ignored whenever the state isn't 'sleeping', so stray audio after a wake (or during a session) never gets processed twice. */
  ingestAudioChunk(chunk: ArrayBuffer): void {
    if (this.state !== 'sleeping' || !this.frameBuffer) return
    const frames = this.frameBuffer.push(new Int16Array(chunk))
    for (const frame of frames) {
      if (wakeWordEngine.processFrame(frame)) {
        this.handleWake()
        break // the session about to start owns the mic now — no point processing the rest of this chunk
      }
    }
  }

  private handleWake(): void {
    if (this.state !== 'sleeping') return
    this.wakeCount++
    this.lastWakeAt = new Date().toISOString()
    logInfo('presence', `wake word detected (#${this.wakeCount})`)
    this.frameBuffer?.reset()
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
      accessKeyConfigured: Boolean(config.picovoiceAccessKey),
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
