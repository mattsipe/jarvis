import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { broadcast } from '../window'
import { config } from '../config'
import { logInfo, logError } from '../logger'

export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; version: string }
  | { phase: 'not-available' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

let lastState: UpdateState = { phase: 'idle' }

function setState(state: UpdateState): void {
  lastState = state
  broadcast('update:state', state)
}

export function getUpdateState(): UpdateState {
  return lastState
}

let configured = false

/**
 * Wraps electron-updater against the GitHub Releases provider (see the
 * `publish` block in electron-builder.yml, which embeds app-update.yml into
 * the packaged app at build time — no credentials are needed at runtime,
 * public releases only, so nothing here ever requires a GitHub login on the
 * Windows PC). Downloads are explicit/background (autoDownload = false), and
 * installing is always gated on a user-visible "Restart JARVIS?" prompt —
 * see ipc.ts's 'update:install' handler.
 */
export function initUpdater(): void {
  if (configured) return
  configured = true

  // Dev builds have no packaged app-update.yml and would just error noisily
  // on every check — the feature only makes sense for a packaged install.
  if (is.dev || !app.isPackaged) {
    logInfo('updater', 'skipped in dev — no packaged app-update.yml')
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = config.updateChannel === 'test'
  // Must match electron-builder.yml's publish.channel exactly — that's what
  // names the metadata file (test.yml) electron-updater looks for on the
  // release. Left unset ('latest', the electron-updater default) once
  // electron-builder.yml's channel is removed for a real stable release.
  autoUpdater.channel = config.updateChannel === 'test' ? 'test' : 'latest'

  autoUpdater.on('checking-for-update', () => {
    logInfo('updater', 'checking for update')
    setState({ phase: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    logInfo('updater', `update available: ${info.version}`)
    setState({ phase: 'available', version: info.version })
    // Background download, as requested — the user is only interrupted
    // once it's actually ready to install.
    autoUpdater.downloadUpdate().catch((err) => {
      logError('updater', `downloadUpdate failed: ${err.message}`)
      setState({ phase: 'error', message: err.message })
    })
  })

  autoUpdater.on('update-not-available', () => {
    logInfo('updater', 'no update available')
    setState({ phase: 'not-available' })
  })

  autoUpdater.on('download-progress', (progress) => {
    setState({ phase: 'downloading', percent: Math.round(progress.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    logInfo('updater', `update ready: ${info.version}`)
    setState({ phase: 'ready', version: info.version })
  })

  autoUpdater.on('error', (err) => {
    logError('updater', err.message)
    setState({ phase: 'error', message: err.message })
  })
}

/** Manual trigger — the startup check and Command Center's "Check for Updates" action both call this. */
export function checkForUpdates(): void {
  if (is.dev || !app.isPackaged) {
    setState({ phase: 'error', message: 'Updates are only available in a packaged build.' })
    return
  }
  autoUpdater.checkForUpdates().catch((err) => {
    logError('updater', `checkForUpdates failed: ${err.message}`)
    setState({ phase: 'error', message: err.message })
  })
}

/** Only ever called from the user's explicit "Restart JARVIS?" confirmation — never automatic. */
export function installUpdateAndRestart(): void {
  if (lastState.phase !== 'ready') return
  logInfo('updater', 'restarting to install update')
  autoUpdater.quitAndInstall()
}
