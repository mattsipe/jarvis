import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { setInteractive, getOverlayWindow } from './window'
import { VoiceSession } from './voice/session'

let session: VoiceSession | null = null
let sessionActive = false

/**
 * Hotkey-driven session control: first press starts a continuous
 * conversation (see VoiceSession — auto-submits per utterance, listening
 * resumes automatically between turns), second press ends it immediately
 * regardless of which phase it's in. Called from main/index.ts's global
 * shortcut handler.
 */
export function toggleSession(): void {
  const win = getOverlayWindow()
  if (!win) return

  if (!sessionActive) {
    sessionActive = true
    session = new VoiceSession(win, () => {
      sessionActive = false
      session = null
    })
    win.webContents.send('voice:toggle', { listening: true })
  } else {
    session?.endSession()
    sessionActive = false
    session = null
    win.webContents.send('voice:toggle', { listening: false })
  }
}

export function registerIpcHandlers(): void {
  ipcMain.on('hud:set-interactive', (_event, interactive: boolean) => {
    setInteractive(interactive)
  })

  ipcMain.on('voice:start', (_event, sampleRate: number) => {
    session?.beginListening(sampleRate)
  })

  ipcMain.on('voice:audio-chunk', (_event, chunk: ArrayBuffer) => {
    session?.pushAudio(Buffer.from(chunk))
  })

  // Renderer is the only one who knows when actual audio *playback*
  // (not just TTS generation) has finished — that's the correct moment
  // to resume listening for the next turn.
  ipcMain.on('voice:playback-finished', () => {
    session?.resumeAfterPlayback()
  })

  // Barge-in: renderer's local VAD detected the user talking while JARVIS
  // was thinking/speaking. `preroll` is the few hundred ms it buffered
  // while only monitoring, so the interruption's first words aren't lost.
  ipcMain.on(
    'voice:barge-in',
    (_event, payload: { sampleRate: number; preroll: ArrayBuffer[] }) => {
      session?.bargeIn(
        payload.sampleRate,
        payload.preroll.map((buf) => Buffer.from(buf))
      )
    }
  )

  // Dev-only: lets automated/manual testing trigger the exact same code path
  // as the real hotkey, without needing OS Accessibility permission to
  // simulate a real keystroke. Never registered in a packaged build — the
  // hotkey remains the only trigger for real usage.
  if (is.dev) {
    ipcMain.on('voice:dev-toggle', () => toggleSession())
  }
}
