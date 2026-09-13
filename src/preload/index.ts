import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

/**
 * Narrow, typed surface exposed to the renderer. No API keys, no Node
 * access, no raw ipcRenderer — only the specific calls the HUD needs.
 * Shared verbatim by both windows (Ambient overlay + Command Center) —
 * main is the single source of truth and broadcasts to whichever of them
 * are open (see main/window.ts's broadcast()).
 */
const jarvisAPI = {
  /** Tell main whether the pointer is over interactive HUD content, so the
   *  click-through overlay can accept input only where it needs to. */
  setInteractive(interactive: boolean): void {
    ipcRenderer.send('hud:set-interactive', interactive)
  },

  // --- Voice loop (M2) ---
  startListening(sampleRate: number): void {
    ipcRenderer.send('voice:start', sampleRate)
  },
  sendAudioChunk(chunk: ArrayBuffer): void {
    ipcRenderer.send('voice:audio-chunk', chunk)
  },
  onToggleListening: (cb: (payload: { listening: boolean }) => void) =>
    on('voice:toggle', cb),
  onTranscript: (cb: (payload: { text: string; isFinal: boolean }) => void) =>
    on('voice:transcript', cb),
  onAssistantText: (cb: (sentence: string) => void) => on('voice:assistant-text', cb),
  onHudState: (cb: (state: string) => void) => on('hud:state', cb),
  onTtsAudioChunk: (cb: (chunk: ArrayBuffer) => void) => on('voice:tts-audio-chunk', cb),
  onTtsDone: (cb: () => void) => on('voice:tts-done', cb),
  onAgentDone: (cb: (payload: { tier: string }) => void) => on('voice:agent-done', cb),
  onVoiceError: (cb: (payload: { message: string; stage: string }) => void) =>
    on('voice:error', cb),
  /** Per-turn latency waterfall snapshot — see voice/telemetry.ts and the Command Center diagnostics panel. */
  onLatency: (cb: (payload: Record<string, unknown>) => void) => on('voice:latency', cb),

  // --- Continuous conversation (M2 follow-up) ---
  /** Tell main the actual audio playback (not just TTS generation) has finished. */
  notifyPlaybackFinished(): void {
    ipcRenderer.send('voice:playback-finished')
  },
  /** Tell main the first sample of a reply was just scheduled — the true playback-start latency mark. */
  notifyPlaybackStarted(): void {
    ipcRenderer.send('voice:playback-started')
  },
  /** Main says it's time to start listening for the next turn. */
  onResumeListening: (cb: () => void) => on('voice:resume-listening', cb),
  /** The whole conversation session ended (hotkey pressed again, or inactivity timeout). */
  onSessionEnded: (cb: () => void) => on('voice:session-ended', cb),

  // --- Barge-in (M2.5) ---
  /** Local VAD detected the user talking over JARVIS — cancel the current turn and listen. */
  notifyBargeIn(sampleRate: number, preroll: ArrayBuffer[]): void {
    ipcRenderer.send('voice:barge-in', { sampleRate, preroll })
  },

  /** Ambient (the only window that actually captures/plays audio) forwards its live amplitude so Command Center's core can react to it too. */
  reportAmplitude(value: number | null): void {
    ipcRenderer.send('hud:amplitude-relay', value)
  },
  onAmplitudeRelay: (cb: (value: number | null) => void) => on('hud:amplitude-relay', cb),

  // --- Command Center / Ambient (two-mode UI) ---
  toggleCommandCenter(): void {
    ipcRenderer.send('command-center:toggle')
  },
  /** Explicit switches — Ambient and Command Center are mutually exclusive, never both visible. */
  switchToCommandCenter(): void {
    ipcRenderer.send('surface:show-command-center')
  },
  switchToAmbient(): void {
    ipcRenderer.send('surface:show-ambient')
  },
  toggleVoiceSession(): void {
    ipcRenderer.send('voice:toggle-session')
  },
  /** A renderer-side voice failure (e.g. getUserMedia rejecting) with no session to report through. */
  reportVoiceError(payload: { message: string; stage: string }): void {
    ipcRenderer.send('voice:renderer-error', payload)
  },

  // --- Tool execution / risk gating (M3) ---
  respondToolConfirmation(id: string, approved: boolean): void {
    ipcRenderer.send('tool:confirm-response', { id, approved })
  },
  onToolConfirmRequest: (cb: (payload: { id: string; toolName: string; description: string }) => void) =>
    on('tool:confirm-request', cb),
  onToolConfirmResolved: (cb: (payload: { id: string; approved: boolean; reason: string }) => void) =>
    on('tool:confirm-resolved', cb),
  onToolActivity: (cb: (payload: Record<string, unknown>) => void) => on('tool:activity', cb),
  getToolActivityHistory: (): Promise<unknown[]> => ipcRenderer.invoke('tool:activity-history'),

  // --- Diagnostics / context (Command Center panels) ---
  getUsageSnapshot: (): Promise<unknown> => ipcRenderer.invoke('usage:snapshot'),
  getLiveContext: (): Promise<unknown> => ipcRenderer.invoke('context:live'),
  getPersistentContext: (): Promise<unknown> => ipcRenderer.invoke('context:persistent'),
  getServicesStatus: (): Promise<{ anthropic: boolean; elevenlabs: boolean; deepgram: boolean }> =>
    ipcRenderer.invoke('config:services-status'),

  /** Dev-only — see ipc.ts's 'dev:test-agent-turn'. Not registered in production; rejects there. */
  devTestAgentTurn: (text: string): Promise<unknown> => ipcRenderer.invoke('dev:test-agent-turn', text)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('jarvis', jarvisAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.jarvis = jarvisAPI
}

export type JarvisAPI = typeof jarvisAPI
