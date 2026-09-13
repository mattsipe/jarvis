import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { getPlatformControl } from '../platform'
import { jarvisHelper } from '../platform/helper'
import { logInfo, logError } from '../logger'

export type AppKind = 'packaged' | 'shortcut' | 'exe' | 'steam-game'

export interface AppCatalogEntry {
  displayName: string
  kind: AppKind
  /** What actually gets launched: a packaged AppUserModelID, a path/name for Start-Process (or `open -a`), or a Steam app ID. */
  launchTarget: string
  appId?: string
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

let catalog: AppCatalogEntry[] = []
let lastRefreshedAt = 0

function catalogFilePath(): string {
  return join(app.getPath('userData'), 'apps.json')
}

/**
 * The app catalog behind "smart app resolution" (resolver.ts) — Start
 * Menu/packaged apps via the platform adapter's Get-StartApps-backed
 * listInstalledApps() (infrequent, so PowerShell's latency doesn't
 * matter), plus Steam's own game list via the native helper (Steam games
 * rarely have Start Menu shortcuts, so Get-StartApps alone would miss
 * most of them). Refreshed at startup and once a day; cached to disk so
 * app resolution still works immediately after a restart, before the
 * first refresh completes.
 */
export async function refreshCatalog(): Promise<void> {
  const entries: AppCatalogEntry[] = []

  try {
    const apps = await getPlatformControl().listInstalledApps()
    for (const { name, appId } of apps) {
      const isPackaged = /![^!]+$/.test(appId)
      entries.push({ displayName: name, kind: isPackaged ? 'packaged' : 'shortcut', launchTarget: appId, appId })
    }
  } catch (err) {
    logError('apps:catalog', `installed-app enumeration failed: ${(err as Error).message}`)
  }

  if (process.platform === 'win32') {
    try {
      const steam = await jarvisHelper.steamCatalog()
      if (steam.steamExePath) entries.push({ displayName: 'Steam', kind: 'exe', launchTarget: steam.steamExePath })
      for (const game of steam.games) {
        entries.push({ displayName: game.name, kind: 'steam-game', launchTarget: game.appId, appId: game.appId })
      }
    } catch (err) {
      logError('apps:catalog', `Steam catalog failed: ${(err as Error).message}`)
    }
  }

  catalog = entries
  lastRefreshedAt = Date.now()
  try {
    writeFileSync(catalogFilePath(), JSON.stringify({ refreshedAt: lastRefreshedAt, entries }, null, 2), 'utf-8')
  } catch (err) {
    logError('apps:catalog', `failed to cache catalog to disk: ${(err as Error).message}`)
  }
  logInfo('apps:catalog', `refreshed: ${entries.length} entries`)
}

function loadCachedCatalog(): void {
  try {
    const raw = readFileSync(catalogFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as { refreshedAt: number; entries: AppCatalogEntry[] }
    catalog = parsed.entries
    lastRefreshedAt = parsed.refreshedAt
  } catch {
    // No cache yet (fresh install) — refreshCatalog() below will populate it shortly.
  }
}

/** Called once at startup (main/index.ts) — loads the disk cache immediately, then refreshes in the background and daily thereafter. */
export function scheduleCatalogRefresh(): void {
  loadCachedCatalog()
  void refreshCatalog()
  setInterval(() => void refreshCatalog(), REFRESH_INTERVAL_MS)
}

export function getCatalog(): AppCatalogEntry[] {
  return catalog
}

export function catalogAgeMs(): number {
  return lastRefreshedAt ? Date.now() - lastRefreshedAt : Infinity
}
