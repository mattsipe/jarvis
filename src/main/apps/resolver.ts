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

/** Penalize obvious wrong-variant matches (uninstallers, "classic" editions, VR spinoffs, etc.) unless the query itself asked for them. */
const NEGATIVE_TOKENS = ['classic', 'uninstall', 'help', 'readme', 'setup', 'update', 'vr', 'server', 'launcher', 'beta']

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
    // Alias points somewhere not in the current catalog snapshot (e.g. a raw path/name Weston gave directly) — launch it as-is.
    return { entry: { displayName: aliasTarget, kind: 'shortcut', launchTarget: aliasTarget } }
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
