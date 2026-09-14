import type { AppCatalogEntry, AppKind } from './catalog'
import type { PlatformControl, ToolResult } from '../platform/types'

export interface LaunchAttempt {
  displayName: string
  kind: AppKind
  ok: boolean
  message: string
}

export interface LaunchWithFallbackResult {
  result: ToolResult
  attempts: LaunchAttempt[]
  /** The candidate that actually launched successfully, if any. */
  winningCandidate: AppCatalogEntry | null
  /** True when the first candidate failed outright and a later one had to be tried. */
  usedFallback: boolean
}

export type CandidateLauncher = (candidate: AppCatalogEntry) => Promise<ToolResult>

/**
 * The universal "try each discovered candidate for this app name, in
 * order, with the correct native mechanism for its kind, until one
 * actually works" loop — see windows.ts's class doc comment bug #4 for
 * why this exists (real-PC testing found apps whose sole discovered
 * candidate resolved but failed to launch; retrying with a genuinely
 * different candidate, when one is available, is strictly more robust
 * than only ever trying the top-scored one and giving up).
 *
 * Only a hard failure (a candidate's launch throwing/returning
 * `ok:false`) advances to the next candidate — an `ok:true` result that
 * merely couldn't be verified in time (see windows.ts's
 * verifyNewWindowAppeared) is accepted as-is, matching the existing
 * single-candidate behavior: some apps are just slow to open a window,
 * and that alone was never treated as a failure.
 *
 * Pure aside from the injected `launch` function, so candidate-fallback
 * ordering is fully unit-testable without Electron or a real Windows
 * machine — see launcher.test.ts.
 */
export async function launchWithFallback(candidates: AppCatalogEntry[], launch: CandidateLauncher): Promise<LaunchWithFallbackResult> {
  const attempts: LaunchAttempt[] = []
  for (const candidate of candidates) {
    const result = await launch(candidate)
    attempts.push({ displayName: candidate.displayName, kind: candidate.kind, ok: result.ok, message: result.message })
    if (result.ok) {
      return { result, attempts, winningCandidate: candidate, usedFallback: attempts.length > 1 }
    }
  }
  const last = attempts[attempts.length - 1]
  return {
    result: last ? { ok: false, message: last.message } : { ok: false, message: 'No launch candidates were available.' },
    attempts,
    winningCandidate: null,
    usedFallback: attempts.length > 1
  }
}

/** Dispatches one candidate to the right PlatformControl primitive for its kind — see apps/catalog.ts's AppKind. */
export function makePlatformLauncher(platform: PlatformControl): CandidateLauncher {
  return (candidate) => {
    if (candidate.kind === 'packaged') return platform.launchByAppId(candidate.appId ?? candidate.launchTarget)
    if (candidate.kind === 'steam-game') return platform.launchSteamGame(candidate.appId ?? candidate.launchTarget)
    return platform.openApp(candidate.launchTarget)
  }
}
