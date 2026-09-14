import { getCatalog, type AppCatalogEntry } from './catalog'
import { contextManager } from '../context'

export interface ResolvedApp {
  entry: AppCatalogEntry
}

export interface AmbiguousApps {
  ambiguous: true
  candidates: AppCatalogEntry[]
}

export type AppResolution = ResolvedApp | AmbiguousApps | null

/**
 * Penalize obvious wrong-variant matches unless the query itself asked
 * for them — e.g. "Steam" should never tie with "SteamVR", "Steam
 * Support", "Steam Client Bootstrapper", or an uninstaller entry.
 */
const NEGATIVE_TOKENS = [
  'classic',
  'uninstall',
  'help',
  'readme',
  'setup',
  'update',
  'updater',
  'vr',
  'server',
  'launcher',
  'beta',
  'support',
  'tools',
  'config',
  'configuration',
  'service',
  'webhelper',
  'bootstrapper',
  'crash',
  'controller'
]

const AMBIGUITY_MARGIN = 15

function score(query: string, entry: AppCatalogEntry): number {
  const q = query.toLowerCase().trim()
  const name = entry.displayName.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80

  const qTokens = q.split(/\s+/).filter(Boolean)
  const nameTokens = name.split(/\s+/).filter(Boolean)
  let overlap = 0
  for (const t of qTokens) if (nameTokens.includes(t)) overlap++

  let s = overlap * 20
  if (overlap === 0 && name.includes(q)) s += 10

  for (const neg of NEGATIVE_TOKENS) {
    if (name.includes(neg) && !q.includes(neg)) s -= 25
  }
  return s
}

/**
 * "Smart app resolution" — see the capability-phase plan's fix for Outlook
 * (new vs. classic) and Steam (client vs. games). Order: an explicit
 * alias from memory always wins (no scoring at all); otherwise the
 * catalog is scored and the resolver only returns an outright answer when
 * the top candidate clears the next one by AMBIGUITY_MARGIN — a genuine
 * tie is returned as `ambiguous` so the caller (tools/apps.ts) can ask
 * Weston once, then save the answer as an alias so it's never ambiguous
 * again.
 */
export function resolveApp(query: string): AppResolution {
  const aliasTarget = contextManager.memory.aliases().get(query.toLowerCase().trim())
  const catalog = getCatalog()

  if (aliasTarget) {
    const aliasMatch = catalog.find((e) => e.displayName.toLowerCase() === aliasTarget.toLowerCase() || e.launchTarget === aliasTarget)
    if (aliasMatch) return { entry: aliasMatch }
    // Alias points somewhere not in the current catalog snapshot (catalog
    // staleness, a rename upstream, or a raw path/name Weston gave
    // directly). Classify it by its own shape rather than assuming it's
    // a safe exe/path — a saved AUMID-shaped alias (e.g. New Outlook's
    // own "PackageFamilyName!App") is not a real path, and Start-Process
    // fails on it exactly the way it failed on Excel's Click-to-Run
    // AppID (see windows.ts's class doc comment bug #3). A confirmed
    // real-PC regression traced to exactly this branch — see bug #4.
    const looksLikeAumid = aliasTarget.includes('!')
    return {
      entry: {
        displayName: aliasTarget,
        kind: looksLikeAumid ? 'packaged' : 'shortcut',
        launchTarget: aliasTarget,
        appId: looksLikeAumid ? aliasTarget : undefined
      }
    }
  }

  const scored = catalog
    .map((entry) => ({ entry, s: score(query, entry) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)

  if (scored.length === 0) return null
  if (scored.length === 1 || scored[0].s - scored[1].s >= AMBIGUITY_MARGIN) {
    return { entry: scored[0].entry }
  }
  return { ambiguous: true, candidates: scored.slice(0, 4).map((x) => x.entry) }
}

/**
 * Ordered launch candidates for an already-resolved entry — the resolved
 * entry itself first, then any *other* catalog entries with the exact
 * same display name but a different launch target (e.g. an app
 * discovered both via Get-StartApps and the App Paths registry — see
 * windows.ts's listInstalledApps()). Only exact-name duplicates are ever
 * considered interchangeable here; this deliberately never substitutes a
 * different *app* (e.g. it will never offer "Outlook classic" as a
 * fallback for "new Outlook") — that distinction is what resolveApp()'s
 * ambiguity check is for, and it's a real semantic choice a user should
 * be asked about, not one apps/launcher.ts should silently guess.
 * Capped at 3 candidates, since a real app has at most a couple of
 * genuinely distinct discovery-source representations.
 */
export function candidatesForLaunch(entry: AppCatalogEntry): AppCatalogEntry[] {
  const sameName = getCatalog().filter((e) => e.displayName.toLowerCase() === entry.displayName.toLowerCase())
  const ordered = [entry, ...sameName.filter((e) => e.launchTarget !== entry.launchTarget)]
  const seen = new Set<string>()
  const deduped: AppCatalogEntry[] = []
  for (const candidate of ordered) {
    if (seen.has(candidate.launchTarget)) continue
    seen.add(candidate.launchTarget)
    deduped.push(candidate)
  }
  return deduped.slice(0, 3)
}
