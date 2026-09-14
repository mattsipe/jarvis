import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { getPlatformControl } from '../platform'
import { jarvisHelper } from '../platform/helper'
import { logInfo, logError } from '../logger'
import { mintCanonicalId, type InstalledApplication } from './types'

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000
const CACHE_SCHEMA_VERSION = 2 // bumped when the record shape changed from {name,kind,launchTarget} to InstalledApplication

let catalog: InstalledApplication[] = []
let lastRefreshedAt = 0

function catalogFilePath(): string {
  return join(app.getPath('userData'), 'apps.json')
}

/**
 * The app catalog behind "smart app resolution" — the platform adapter's
 * listInstalledApps() (Get-StartApps-backed, infrequent so PowerShell's
 * latency doesn't matter) plus Steam's own game list via the native
 * helper (Steam games rarely have Start Menu shortcuts, so Get-StartApps
 * alone would miss most of them). Refreshed at startup and once a day;
 * cached to disk so app resolution still works immediately after a
 * restart, before the first refresh completes.
 *
 * This is the ONLY module allowed to call mintCanonicalId() — every
 * InstalledApplication record here comes directly from something the OS
 * itself reported (Get-StartApps' AppID, or the helper's verified Steam
 * exe/app IDs), never from memory, a preference, or free text. See
 * apps/types.ts's CanonicalAppId doc comment and the plan's root-cause
 * writeup for why that boundary exists at all.
 */
export async function refreshCatalog(): Promise<void> {
  const entries: InstalledApplication[] = []

  try {
    const apps = await getPlatformControl().listInstalledApps()
    entries.push(...apps)
  } catch (err) {
    logError('apps:catalog', `installed-app enumeration failed: ${(err as Error).message}`)
  }

  if (process.platform === 'win32') {
    try {
      const steam = await jarvisHelper.steamCatalog()
      if (steam.steamExePath) {
        // The helper only ever returns a verified (File.Exists-checked)
        // path — see SteamCatalog.cs's ResolveSteamExe(). Treat it as
        // authoritative for the name "Steam": drop any Start-Menu-sourced
        // entry that would otherwise tie with it in ranking (a shortcut
        // literally named "Steam", possibly pointing at a bootstrapper or
        // a stale path) so "open Steam" never has to guess between two
        // entries that both claim to be the client.
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].displayName.trim().toLowerCase() === 'steam') entries.splice(i, 1)
        }
        entries.push({
          canonicalId: mintCanonicalId(steam.steamExePath),
          displayName: 'Steam',
          registrationSource: 'steam',
          launchKind: 'desktop-path',
          appId: steam.steamExePath
        })
      }
      for (const game of steam.games) {
        entries.push({
          canonicalId: mintCanonicalId(`steam:${game.appId}`),
          displayName: game.name,
          registrationSource: 'steam',
          launchKind: 'steam-game',
          appId: game.appId
        })
      }
    } catch (err) {
      logError('apps:catalog', `Steam catalog failed: ${(err as Error).message}`)
    }
  }

  catalog = entries
  lastRefreshedAt = Date.now()
  try {
    writeFileSync(catalogFilePath(), JSON.stringify({ schemaVersion: CACHE_SCHEMA_VERSION, refreshedAt: lastRefreshedAt, entries }, null, 2), 'utf-8')
  } catch (err) {
    logError('apps:catalog', `failed to cache catalog to disk: ${(err as Error).message}`)
  }
  logInfo('apps:catalog', `refreshed: ${entries.length} entries`)
}

function loadCachedCatalog(): void {
  try {
    const raw = readFileSync(catalogFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as { schemaVersion?: number; refreshedAt: number; entries: InstalledApplication[] }
    // An older cache (pre-InstalledApplication shape) is discarded, not
    // migrated — refreshCatalog() below repopulates it within moments of
    // startup, and there's nothing worth salvaging from the old shape.
    if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION) return
    catalog = parsed.entries
    lastRefreshedAt = parsed.refreshedAt
  } catch {
    // No cache yet (fresh install, or a discarded old-schema one) — refreshCatalog() below will populate it shortly.
  }
}

/** Called once at startup (main/index.ts) — loads the disk cache immediately, then refreshes in the background and daily thereafter. */
export function scheduleCatalogRefresh(): void {
  loadCachedCatalog()
  void refreshCatalog()
  setInterval(() => void refreshCatalog(), REFRESH_INTERVAL_MS)
}

export function getCatalog(): InstalledApplication[] {
  return catalog
}

export function catalogAgeMs(): number {
  return lastRefreshedAt ? Date.now() - lastRefreshedAt : Infinity
}
