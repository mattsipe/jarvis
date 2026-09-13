import { app, BrowserWindow, screen, shell, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { contextManager } from './context'

let overlayWindow: BrowserWindow | null = null
let commandCenterWindow: BrowserWindow | null = null
let tray: Tray | null = null

// Kept as plain strings/booleans (not an import of presence's own status
// type) so window.ts never needs to import main/presence/ — presence
// already imports from here (broadcast, showCommandCenter), and importing
// back would make the two modules circular for no real benefit.
let trayStatusLabel = 'Presence: starting…'
let trayMuted = false
let trayMuteHandler: (() => void) | null = null

/**
 * Which surface is the intended, user-visible one right now. Ambient is an
 * optional presentation mode, not a permanent overlay — see the lifecycle
 * fix below. `null` means neither is currently shown (e.g. dismissed via
 * the Command Center hotkey, recoverable from the tray).
 */
type Surface = 'command-center' | 'ambient' | null
let activeSurface: Surface = null

// Both windows hide instead of close (so the app keeps running) except when
// the whole app is actually quitting, tracked here so their 'close' handlers
// can tell the difference.
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

/**
 * The overlay is a single fullscreen, transparent, frameless, always-on-top
 * window that never resizes or repositions. This is Ambient Mode — JARVIS's
 * living core over the desktop. It is created once (hidden) and its
 * renderer is what actually owns the microphone/TTS playback (see
 * App.tsx), so it must stay alive even while visually hidden — voice works
 * the same whether the user is looking at Ambient or the Command Center.
 * `backgroundThrottling: false` keeps its rAF-driven amplitude relay (see
 * audio/playback.ts) running at full rate while hidden, so the Command
 * Center's core stays reactive even when Ambient is never shown.
 *
 * It is NEVER shown automatically — see showAmbient()/showCommandCenter().
 */
function ensureOverlayWindow(): BrowserWindow {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow

  const primaryDisplay = screen.getPrimaryDisplay()
  const { width, height } = primaryDisplay.bounds

  overlayWindow = new BrowserWindow({
    x: 0,
    y: 0,
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })
  // look_at_screen (tools/perception.ts) must never see JARVIS's own core/rings —
  // excludes this window from any screen capture, including its own. Windows
  // 10 2004+ and modern macOS; on an older OS this is a no-op (window still
  // renders normally on the real display either way).
  overlayWindow.setContentProtection(true)

  overlayWindow.on('closed', () => {
    overlayWindow = null
  })

  overlayWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return overlayWindow
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

/**
 * Called once at startup — creates the (hidden) overlay window so its
 * renderer, which owns the real microphone/TTS audio graph, is alive and
 * ready before the user ever starts a conversation, regardless of which
 * surface (Ambient or Command Center) they're actually looking at.
 */
export function ensureVoiceSurfaceExists(): void {
  ensureOverlayWindow()
}

/** Renderer calls this (via preload) when the pointer enters/leaves interactive HUD content. */
export function setInteractive(interactive: boolean): void {
  if (!overlayWindow) return
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true })
}

/**
 * Command Center — the default, primary surface: a normal, resizable,
 * maximizable Electron window. Built around the same Core/Rings/state/voice
 * infrastructure, laid out as panels around the central reactor. Created
 * lazily on first open; hidden (not destroyed) afterward so its state
 * persists and reopening is instant.
 */
function ensureCommandCenterWindow(): BrowserWindow {
  if (commandCenterWindow && !commandCenterWindow.isDestroyed()) return commandCenterWindow

  commandCenterWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'JARVIS — Command Center',
    backgroundColor: '#05070c',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  commandCenterWindow.on('show', () => contextManager.setCommandCenterOpen(true))
  commandCenterWindow.on('hide', () => contextManager.setCommandCenterOpen(false))

  // Closing the window just hides it — the app (and the voice session)
  // keeps running. Only actually destroyed when the whole app quits.
  commandCenterWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    commandCenterWindow?.hide()
    if (activeSurface === 'command-center') activeSurface = null
  })
  commandCenterWindow.on('closed', () => {
    commandCenterWindow = null
    contextManager.setCommandCenterOpen(false)
  })

  commandCenterWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    commandCenterWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/command-center.html`)
  } else {
    commandCenterWindow.loadFile(join(__dirname, '../renderer/command-center.html'))
  }

  return commandCenterWindow
}

export function getCommandCenterWindow(): BrowserWindow | null {
  return commandCenterWindow
}

/**
 * Shows the Command Center and hides Ambient (if it was showing) — the two
 * are mutually exclusive presentations of the one app, never both visible
 * at once. This is the default surface at launch.
 */
export function showCommandCenter(): void {
  const cc = ensureCommandCenterWindow()
  cc.show()
  cc.focus()
  activeSurface = 'command-center'
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.hide()
}

/** Shows Ambient Mode and hides the Command Center — an explicit, opt-in switch, never automatic. */
export function showAmbient(): void {
  const amb = ensureOverlayWindow()
  amb.showInactive() // click-through/always-on-top presence — doesn't need to steal focus like a real window
  activeSurface = 'ambient'
  if (commandCenterWindow && !commandCenterWindow.isDestroyed()) commandCenterWindow.hide()
}

/** Global hotkey / tray — brings up the Command Center, or dismisses it if it's already the visible surface. */
export function toggleCommandCenter(): void {
  if (activeSurface === 'command-center' && commandCenterWindow?.isVisible()) {
    commandCenterWindow.hide()
    activeSurface = null
  } else {
    showCommandCenter()
  }
}

/** Sends one IPC message to every live JARVIS surface (Ambient + Command Center, whichever exist — shown or hidden). */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of [overlayWindow, commandCenterWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * A tray icon is the only reliable way to get back to a visible surface
 * (or to actually quit) once both windows are hidden — critical on
 * Windows, which has no dock/menu-bar equivalent for a window-less app.
 * Also the one place Presence's sleeping/listening/muted state is visible
 * even when both windows are hidden (the whole point of "launches quietly
 * in the background") — see setTrayStatus, called from presence/index.ts
 * on every state change.
 */
export function createTray(): void {
  const iconPath = join(__dirname, '../../resources/tray-icon-32.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  rebuildTray()
  tray.on('click', () => showCommandCenter())
}

/** Registered once from main/index.ts — the tray's Mute/Unmute item calls back into presence.toggleMuted() without window.ts needing to import presence/index.ts. */
export function setTrayMuteHandler(handler: () => void): void {
  trayMuteHandler = handler
}

/** Called from presence/index.ts whenever Presence's state changes, so the tray tooltip/menu stay accurate without any window ever needing to be visible. */
export function setTrayStatus(label: string, muted: boolean): void {
  trayStatusLabel = label
  trayMuted = muted
  rebuildTray()
}

function rebuildTray(): void {
  if (!tray) return
  tray.setToolTip(`JARVIS — ${trayStatusLabel}`)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Command Center', click: () => showCommandCenter() },
      { label: 'Ambient Mode', click: () => showAmbient() },
      { type: 'separator' },
      { label: trayStatusLabel, enabled: false },
      { label: trayMuted ? 'Unmute' : 'Mute', click: () => trayMuteHandler?.() },
      { type: 'separator' },
      { label: 'Quit JARVIS', click: () => app.quit() }
    ])
  )
}
