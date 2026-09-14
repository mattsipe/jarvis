import { app } from 'electron'
import { logInfo } from '../logger'
import { broadcast, showCommandCenter, setTrayStatus } from '../window'
import { wakeWordEngine } from './wakeword'
import { FrameBuffer } from './frameBuffer'
import { getPresenceConfig, updatePresenceConfig } from './config'
import { computeState, type PresenceState } from './state'

export type { PresenceState } from './state'

/** Reported once by audio/presenceCapture.ts right after it opens the mic — see that file for why the "actual" fields can't just be assumed to match what was requested. */
export interface PresenceMicStatus {
  requestedSampleRate: number
  actualContextSampleRate: number
  trackSampleRate: number | null
  channelCount: number
  deviceLabel: string | null
  resampling: boolean
}

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
  sensitivity: number
  consecutiveFrames: number
  /** Raw audio chunks accepted from the renderer since the app started — the "is the mic pipeline reaching main at all" check, independent of whether the engine could do anything with them yet. */
  micChunksReceived: number
  /** From audio/presenceCapture.ts's one-time report — null until the mic has actually opened at least once this run. */
  mic: PresenceMicStatus | null
  /** Total 80ms frames actually run through the ONNX pipeline (post-buffering) since the engine started — see wakeword.ts's WakeWordStatus.framesProcessed. */
  engineFramesProcessed: number
  /** This frame's raw "hey jarvis" score (0-1), before thresholding — null until buffers have warmed up. */
  lastScore: number | null
  /** Max score over roughly the last 5 seconds. */
  recentPeakScore: number
  /** Current score threshold, derived live from `sensitivity`. */
  threshold: number
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
  private micChunksReceived = 0
  private micStatus: PresenceMicStatus | null = null

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

  setSensitivity(sensitivity: number): void {
    updatePresenceConfig({ sensitivity: Math.max(0, Math.min(1, sensitivity)) })
    this.recompute() // no state-precedence change, but status() should reflect the new value immediately
  }

  setConsecutiveFrames(consecutiveFrames: number): void {
    updatePresenceConfig({ consecutiveFrames: Math.max(1, Math.round(consecutiveFrames)) })
    this.recompute()
  }

  /** One-shot report from audio/presenceCapture.ts right after it opens the mic — see PresenceMicStatus for why this can't just be assumed from what was requested. */
  reportMicStatus(status: PresenceMicStatus): void {
    this.micStatus = status
    logInfo(
      'presence',
      `mic opened: requested ${status.requestedSampleRate}Hz, context actually running at ${status.actualContextSampleRate}Hz` +
        (status.resampling ? ' (resampling to 16kHz in JS)' : ' (no resampling needed)') +
        `, ${status.channelCount}ch, device="${status.deviceLabel ?? 'unknown'}"`
    )
    this.recompute()
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
    // Counted unconditionally, even if rejected below — the first thing a
    // wake-word report should rule out is "is the renderer's mic pipeline
    // reaching main at all", independent of whether Presence happens to be
    // in a state that actually wants the audio right now.
    this.micChunksReceived++
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
      lastWakeAt: this.lastWakeAt,
      sensitivity: cfg.sensitivity,
      consecutiveFrames: cfg.consecutiveFrames,
      micChunksReceived: this.micChunksReceived,
      mic: this.micStatus,
      engineFramesProcessed: engineStatus.framesProcessed,
      lastScore: engineStatus.lastScore,
      recentPeakScore: engineStatus.recentPeakScore,
      threshold: engineStatus.threshold
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
