import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { setInteractive, getOverlayWindow } from './window'
import { VoiceSession } from './voice/session'

let session: VoiceSession | null = null
let listening = false

/**
 * Hotkey-driven toggle: first call starts listening (opens mic capture in
 * the renderer + STT in main), second call stops it and runs the agent
 * turn. Called from main/index.ts's global shortcut handler.
 */
export function toggleListening(): void {
  const win = getOverlayWindow()
  if (!win) return

  listening = !listening
  win.webContents.send('voice:toggle', { listening })

  if (listening) {
    session = new VoiceSession(win)
  } else if (session) {
    const activeSession = session
    session = null
    activeSession.stopAndRespond().catch((err) => {
      console.error('[jarvis] voice session error:', err)
    })
  }
}

export function registerIpcHandlers(): void {
  ipcMain.on('hud:set-interactive', (_event, interactive: boolean) => {
    setInteractive(interactive)
  })

  ipcMain.on('voice:start', (_event, sampleRate: number) => {
    session?.startListening(sampleRate)
  })

  ipcMain.on('voice:audio-chunk', (_event, chunk: ArrayBuffer) => {
    session?.pushAudio(Buffer.from(chunk))
  })

  // Dev-only: lets automated/manual testing trigger the exact same code path
  // as the real hotkey, without needing OS Accessibility permission to
  // simulate a real keystroke. Never registered in a packaged build — the
  // hotkey remains the only trigger for real usage.
  if (is.dev) {
    ipcMain.on('voice:dev-toggle', () => toggleListening())
  }
}
