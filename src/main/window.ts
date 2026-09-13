import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let overlayWindow: BrowserWindow | null = null

/**
 * The overlay is a single fullscreen, transparent, frameless, always-on-top
 * window that never resizes or repositions. The HUD "unfolds" by animating
 * content within this fixed canvas (ambient orb -> expanded command center)
 * rather than by resizing/moving windows — see the plan's Window strategy.
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
