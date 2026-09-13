import { app, BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { contextManager } from './context'

let overlayWindow: BrowserWindow | null = null
let commandCenterWindow: BrowserWindow | null = null

// The Command Center window hides on close (so the app keeps running in
// Ambient Mode underneath) rather than being destroyed — except when the
// whole app is actually quitting, tracked here so its 'close' handler can
// tell the difference.
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

/**
 * The overlay is a single fullscreen, transparent, frameless, always-on-top
 * window that never resizes or repositions. This is Ambient Mode — JARVIS's
 * living core over the desktop, small/unobtrusive at rest and expanding
 * while listening/thinking/speaking/acting. It is NOT the whole app; see
 * createCommandCenterWindow for the second first-class surface.
 *
 * Click-through is on by default so the desktop underneath stays usable;
 * the renderer tells us (via IPC, wired in ipc.ts) when the pointer is over
 * live HUD content so we can briefly accept input there.
 */
export function createOverlayWindow(): BrowserWindow {
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
      nodeIntegration: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setIgnoreMouseEvents(true, { forward: true })

  overlayWindow.on('ready-to-show', () => overlayWindow?.show())

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

/** Renderer calls this (via preload) when the pointer enters/leaves interactive HUD content. */
export function setInteractive(interactive: boolean): void {
  if (!overlayWindow) return
  overlayWindow.setIgnoreMouseEvents(!interactive, { forward: true })
}

/**
 * Command Center — the second first-class surface: a normal, resizable,
 * maximizable Electron window (not transparent/click-through/always-on-top
 * like the overlay). Built around the same Core/Rings/state/voice
 * infrastructure, laid out as panels (telemetry, transcript, active task,
 * recent actions, integrations, routines) around the central reactor.
 * Created lazily on first open; hidden (not destroyed) afterward so its
 * state persists and reopening is instant.
 */
export function createCommandCenterWindow(): BrowserWindow {
  if (commandCenterWindow && !commandCenterWindow.isDestroyed()) {
    commandCenterWindow.show()
    commandCenterWindow.focus()
    return commandCenterWindow
  }

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

  commandCenterWindow.on('ready-to-show', () => commandCenterWindow?.show())
  commandCenterWindow.on('show', () => contextManager.setCommandCenterOpen(true))
  commandCenterWindow.on('hide', () => contextManager.setCommandCenterOpen(false))

  // Closing the window just returns to Ambient Mode — the app (and the
  // ambient overlay/voice session) keeps running. Only actually destroyed
  // when the whole app quits.
  commandCenterWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    commandCenterWindow?.hide()
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

/** Ambient's launcher control and the global hotkey both call this. */
export function toggleCommandCenter(): void {
  if (commandCenterWindow && !commandCenterWindow.isDestroyed() && commandCenterWindow.isVisible()) {
    commandCenterWindow.hide()
  } else {
    createCommandCenterWindow()
  }
}

/**
 * Sends one IPC message to every live JARVIS surface (Ambient + Command
 * Center, whichever exist). This is what lets both windows reflect the
 * same single voice/agent/tool session rather than each owning its own
 * state — main is the one source of truth, the renderers just mirror it.
 */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of [overlayWindow, commandCenterWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
}
