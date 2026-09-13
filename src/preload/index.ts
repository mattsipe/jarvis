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
 * Extended per milestone (tool activity lands in M3).
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

  // --- Continuous conversation (M2 follow-up) ---
  /** Tell main the actual audio playback (not just TTS generation) has finished. */
  notifyPlaybackFinished(): void {
    ipcRenderer.send('voice:playback-finished')
  },
  /** Main says it's time to start listening for the next turn. */
  onResumeListening: (cb: () => void) => on('voice:resume-listening', cb),
  /** The whole conversation session ended (hotkey pressed again, or inactivity timeout). */
  onSessionEnded: (cb: () => void) => on('voice:session-ended', cb),

  // --- Barge-in (M2.5) ---
  /** Local VAD detected the user talking over JARVIS — cancel the current turn and listen. */
  notifyBargeIn(sampleRate: number, preroll: ArrayBuffer[]): void {
    ipcRenderer.send('voice:barge-in', { sampleRate, preroll })
  }
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
