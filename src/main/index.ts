import { app, globalShortcut, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createOverlayWindow } from './window'
import { registerIpcHandlers } from './ipc'

const HOTKEY = process.env.JARVIS_HOTKEY || 'Control+Space'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.weston.jarvis')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createOverlayWindow()

  // M0/M1 stub: confirms the hotkey plumbing works end to end. Wired to the
  // real STT capture pipeline in M2 (voice loop) — see plan Milestones.
  const registered = globalShortcut.register(HOTKEY, () => {
    if (is.dev) console.log(`[jarvis] hotkey ${HOTKEY} pressed`)
  })
  if (!registered) {
    console.warn(`[jarvis] failed to register hotkey: ${HOTKEY}`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow()
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
