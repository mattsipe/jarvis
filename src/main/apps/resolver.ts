import { getCatalog } from './catalog'
import { rankCandidates, AMBIGUITY_MARGIN } from './rank'
import type { InstalledApplication } from './types'

export interface ResolvedApp {
  entry: InstalledApplication
}

export interface AmbiguousApps {
  ambiguous: true
  candidates: InstalledApplication[]
}

export type AppResolution = ResolvedApp | AmbiguousApps | null

/**
 * Confidence-only check over the real installed-app catalog — no
 * preferences, no launching. Used solely by agent/localCommands.ts's
 * fast "open X" bypass to decide whether a name is unambiguous enough to
 * skip Claude entirely; the actual open_app tool (tools/apps.ts) goes
 * through apps/launchApp.ts instead, which also applies any saved
 * preference and produces a full launch trace.
 *
 * Deliberately holds none of the logic this used to: no alias lookup, no
 * "orphaned alias" fallback that could turn arbitrary text into a launch
 * target — see the plan's root-cause writeup for why that was removed
 * rather than patched again.
 */
export function resolveApp(query: string): AppResolution {
  const ranked = rankCandidates(query, getCatalog(), null)
  if (ranked.length === 0) return null
  if (ranked.length === 1 || ranked[0].score - ranked[1].score >= AMBIGUITY_MARGIN) {
    return { entry: ranked[0].app }
  }
  return { ambiguous: true, candidates: ranked.slice(0, 4).map((r) => r.app) }
}
