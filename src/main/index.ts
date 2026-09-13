import { app, globalShortcut, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config, assertVoiceLoopConfigured } from './config'
import { createOverlayWindow, toggleCommandCenter } from './window'
import { registerIpcHandlers, toggleSession } from './ipc'
import { registerBuiltInTools } from './tools'

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.weston.jarvis')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    assertVoiceLoopConfigured()
  } catch (err) {
    console.warn((err as Error).message)
    console.warn('[jarvis] Voice loop disabled until .env is filled in — the HUD still runs.')
  }

  registerBuiltInTools()
  registerIpcHandlers()
  createOverlayWindow()

  const registered = globalShortcut.register(config.hotkey, () => {
    toggleSession()
    if (is.dev) console.log(`[jarvis] hotkey ${config.hotkey} pressed`)
  })
  if (!registered) {
    console.warn(`[jarvis] failed to register hotkey: ${config.hotkey}`)
  }

  const commandCenterRegistered = globalShortcut.register(config.commandCenterHotkey, () => {
    toggleCommandCenter()
  })
  if (!commandCenterRegistered) {
    console.warn(`[jarvis] failed to register Command Center hotkey: ${config.commandCenterHotkey}`)
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
