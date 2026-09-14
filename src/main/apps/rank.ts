import type { InstalledApplication } from './types'

/**
 * Penalize obvious wrong-variant matches unless the query itself asked
 * for them — e.g. "Steam" should never tie with "SteamVR", "Steam
 * Support", "Steam Client Bootstrapper", or an uninstaller entry.
 */
export const NEGATIVE_TOKENS = [
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

export const AMBIGUITY_MARGIN = 15

/**
 * A preference boost large enough to always outrank ordinary name-match
 * scoring (which tops out well under this), but still just a ranking
 * input — never an identity. A preference for an app that isn't in the
 * candidate list has no effect at all, which is what keeps this from
 * ever being able to conjure a result out of nothing.
 */
export const PREFERENCE_BOOST = 1000

export function scoreCandidate(query: string, displayName: string): number {
  const q = query.toLowerCase().trim()
  const name = displayName.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80

  // Strip parens so "Outlook (classic)" tokenizes as ["outlook","classic"] —
  // without this, a query token like "classic" never matched the
  // punctuation-attached "(classic)" name token, so "outlook classic"
  // scored no higher than plain "outlook" and couldn't resolve reliably.
  const qTokens = q.split(/\s+/).filter(Boolean)
  const nameTokens = name
    .replace(/[()]/g, '')
    .split(/\s+/)
    .filter(Boolean)
  let overlap = 0
  for (const t of qTokens) if (nameTokens.includes(t)) overlap++

  let s = overlap * 20
  if (overlap === 0 && name.includes(q)) s += 10

  for (const neg of NEGATIVE_TOKENS) {
    if (name.includes(neg) && !q.includes(neg)) s -= 25
  }
  return s
}

export interface RankedCandidate {
  app: InstalledApplication
  score: number
}

/**
 * Ranks the installed-app catalog against a spoken/typed name. A
 * `preferredCanonicalId` — from apps/preferences.ts, never from prose
 * memory — only ever nudges which already-scored candidate wins; it can
 * never inject a candidate that doesn't already exist in `catalog`, and a
 * preference for an app no longer installed has already been filtered out
 * by the caller (see launchApp.ts) before it ever reaches here.
 */
export function rankCandidates(query: string, catalog: InstalledApplication[], preferredCanonicalId: string | null): RankedCandidate[] {
  return catalog
    .map((app) => ({
      app,
      score: scoreCandidate(query, app.displayName) + (preferredCanonicalId && app.canonicalId === preferredCanonicalId ? PREFERENCE_BOOST : 0)
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
}
