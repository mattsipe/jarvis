import { app, globalShortcut, session } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { config, assertVoiceLoopConfigured } from './config'
import { showCommandCenter, toggleCommandCenter, ensureVoiceSurfaceExists, createTray, setTrayMuteHandler } from './window'
import { registerIpcHandlers } from './ipc'
import { toggleSession, startSession, endSession } from './voice/sessionManager'
import { registerBuiltInTools } from './tools'
import { initUpdater, checkForUpdates } from './update/updater'
import { scheduleCatalogRefresh } from './apps/catalog'
import { jarvisHelper } from './platform/helper'
import { presence } from './presence'

// Set by electron-builder's login-item args (see presence/index.ts's
// applyLoginItemSettings) — a launch-at-login start should stay in the
// tray/background rather than popping Command Center up unasked for.
const startedHidden = process.argv.includes('--hidden')

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.weston.jarvis')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Chromium's default is to deny 'media' (microphone/camera) permission
  // requests unless a handler explicitly allows them. This app only ever
  // loads its own bundled HTML (never third-party content), so it's safe
  // to always allow — without this, getUserMedia can fail silently on some
  // platforms/builds with no OS-level prompt at all (see the Windows
  // voice-startup investigation: this was a real, confirmed gap).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media')
  })
  // Belt-and-suspenders: some permission types are gated by this
  // synchronous check independently of the async request handler above.
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media')

  try {
    assertVoiceLoopConfigured()
  } catch (err) {
    console.warn((err as Error).message)
    console.warn('[jarvis] Voice loop disabled until .env is filled in — the HUD still runs.')
  }

  registerBuiltInTools()
  registerIpcHandlers()
  createTray()
  setTrayMuteHandler(() => presence.toggleMuted())
  // Loads the cached catalog immediately, then refreshes in the background
  // (and daily thereafter) — see apps/catalog.ts. Never blocks startup.
  scheduleCatalogRefresh()

  // Ambient's renderer owns the real audio graph regardless of which
  // surface is visually active — create it (hidden) up front so voice
  // works immediately even if the user never explicitly opens Ambient Mode.
  ensureVoiceSurfaceExists()

  // Wired here (the composition root) rather than as a direct import in
  // either direction — see presence/index.ts's class comment for why.
  presence.registerSessionControls({ start: startSession, end: endSession })
  presence.start()

  // Command Center is the default, primary surface — Ambient is opt-in
  // (see window.ts's showAmbient/showCommandCenter: the two are mutually
  // exclusive, never both visible at once). A launch-at-login start
  // (--hidden, set by presence's applyLoginItemSettings) stays backgrounded
  // in the tray instead — that's the whole point of "launches quietly".
  if (!startedHidden) showCommandCenter()

  // Startup update check — background, non-blocking, no-op in dev (see
  // updater.ts). A short delay avoids competing with the app's own
  // launch/voice-surface setup for network and CPU.
  initUpdater()
  setTimeout(() => checkForUpdates(), 5000)

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

  // Global mute — mic fully off, wake-word listening included (see
  // presence/index.ts's setMuted). Independent of which surface is visible.
  const muteRegistered = globalShortcut.register(config.muteHotkey, () => {
    presence.toggleMuted()
  })
  if (!muteRegistered) {
    console.warn(`[jarvis] failed to register mute hotkey: ${config.muteHotkey}`)
  }

  // macOS dock icon click with no visible window — bring back the primary surface.
  app.on('activate', () => {
    showCommandCenter()
  })
})

app.on('before-quit', () => {
  globalShortcut.unregisterAll()
  jarvisHelper.stop()
  presence.stop()
})

// Both windows now hide rather than close on their own 'close' handler, so
// this effectively never fires from normal use — quitting is explicit, via
// the tray's "Quit JARVIS". Kept as a safety net in case both windows are
// ever destroyed some other way.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
