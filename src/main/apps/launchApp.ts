import type { InstalledApplication, LaunchOutcome, LaunchTrace } from './types'
import { rankCandidates, AMBIGUITY_MARGIN } from './rank'

export interface LaunchAppDeps {
  getCatalog: () => InstalledApplication[]
  /** apps/preferences.ts's get() — never prose memory. */
  getPreference: (normalizedQuery: string) => string | null
  /** Dispatches to the right native mechanism for the selected app's kind — see tools/apps.ts's createAppLauncher(). */
  launch: (selected: InstalledApplication) => Promise<LaunchOutcome>
}

export interface LaunchAppResult {
  ok: boolean
  message: string
  trace: LaunchTrace
  /** Only set when finalResult is 'ambiguous' — the real candidates to ask Weston about. */
  ambiguousCandidates?: InstalledApplication[]
}

function activationMethodAndTarget(app: InstalledApplication): { method: string; target: string } {
  if (app.launchKind === 'steam-game') return { method: 'Steam protocol', target: `steam://rungameid/${app.appId}` }
  if (app.launchKind === 'desktop-path') return { method: 'ShellExecute (path)', target: app.appId }
  return { method: 'ShellExecute (shell:AppsFolder)', target: `shell:AppsFolder\\${app.appId}` }
}

export interface SelectionDeps {
  getCatalog: () => InstalledApplication[]
  getPreference: (normalizedQuery: string) => string | null
}

export interface SelectionResult {
  trace: LaunchTrace
  selected: InstalledApplication | null
  ambiguousCandidates?: InstalledApplication[]
}

/**
 * The resolve-only half of the pipeline shared by launchAppByName() and
 * resolveAppByName() (the App Launch Lab's "Resolve" button, which
 * deliberately never launches anything) — request → normalize → rank the
 * real catalog with any preference as a ranking boost only → exactly one
 * candidate, a genuine tie, or "not installed". Fills in every trace
 * field this stage owns; the caller fills in the rest once (or if) an
 * actual launch happens.
 */
function selectCandidate(requestedName: string, deps: SelectionDeps): SelectionResult {
  const normalizedQuery = requestedName.toLowerCase().trim()
  const catalog = deps.getCatalog()
  const rawPreferredId = deps.getPreference(normalizedQuery)

  const trace: LaunchTrace = {
    request: requestedName,
    normalizedQuery,
    preference: { query: normalizedQuery, canonicalId: null, status: 'none' },
    candidates: [],
    selected: null,
    registrationSource: null,
    activationMethod: null,
    activationTarget: null,
    activationResult: null,
    observed: null,
    confidence: null,
    finalResult: 'not-installed'
  }

  let appliedPreferenceId: string | null = null
  if (rawPreferredId) {
    const stillInstalled = catalog.some((a) => a.canonicalId === rawPreferredId)
    trace.preference = {
      query: normalizedQuery,
      canonicalId: rawPreferredId,
      status: stillInstalled ? 'applied' : 'ignored-not-installed'
    }
    if (stillInstalled) appliedPreferenceId = rawPreferredId
  }

  const ranked = rankCandidates(normalizedQuery, catalog, appliedPreferenceId)
  trace.candidates = ranked.slice(0, 5).map((r) => ({
    displayName: r.app.displayName,
    canonicalId: r.app.canonicalId,
    launchKind: r.app.launchKind,
    score: r.score
  }))

  if (ranked.length === 0) {
    trace.finalResult = 'not-installed'
    return { trace, selected: null }
  }

  if (ranked.length > 1 && ranked[0].score - ranked[1].score < AMBIGUITY_MARGIN) {
    trace.finalResult = 'ambiguous'
    const candidates = ranked.slice(0, 4).map((r) => r.app)
    return { trace, selected: null, ambiguousCandidates: candidates }
  }

  const selected = ranked[0].app
  trace.selected = { displayName: selected.displayName, canonicalId: selected.canonicalId }
  trace.registrationSource = selected.registrationSource
  const { method, target } = activationMethodAndTarget(selected)
  trace.activationMethod = method
  trace.activationTarget = target
  return { trace, selected }
}

/**
 * Resolution only — never launches anything. Backs the App Launch Lab's
 * "Resolve" button, so real-PC validation can inspect exactly what an
 * app name would resolve to (candidates, the chosen one, the activation
 * target it would use) without actually opening it.
 */
export function resolveAppByName(requestedName: string, deps: SelectionDeps): { ok: boolean; message: string; trace: LaunchTrace; ambiguousCandidates?: InstalledApplication[] } {
  const { trace, selected, ambiguousCandidates } = selectCandidate(requestedName, deps)
  if (ambiguousCandidates) {
    return {
      ok: false,
      message: `More than one app matches "${requestedName}": ${ambiguousCandidates.map((c) => c.displayName).join(', ')}.`,
      trace,
      ambiguousCandidates
    }
  }
  if (!selected) {
    return { ok: false, message: `"${requestedName}" doesn't look like an installed application.`, trace }
  }
  return { ok: true, message: `Would open ${selected.displayName} via ${trace.activationMethod}.`, trace }
}

/**
 * The one path a spoken/typed app name takes from request to result —
 * built specifically so a phrase can never become an activation target
 * (see the plan's root-cause writeup for the regression this replaces).
 *
 * request → normalize → rank the real catalog (with any preference as a
 * ranking boost only) → resolve to exactly one candidate, ask about a
 * genuine tie, or report "not installed" → dispatch the *selected
 * catalog record* (never a raw string) to `deps.launch` → report the
 * outcome honestly, distinguishing "the native call failed" from "it
 * launched but couldn't be verified in time" (see LaunchOutcome).
 *
 * Pure aside from the three injected functions, so this whole pipeline —
 * including the "no arbitrary string can become an activation target"
 * invariant — is unit-testable without Electron or a real Windows
 * machine. See launchApp.test.ts.
 */
export async function launchAppByName(requestedName: string, deps: LaunchAppDeps): Promise<LaunchAppResult> {
  const { trace, selected, ambiguousCandidates } = selectCandidate(requestedName, deps)

  if (ambiguousCandidates) {
    return {
      ok: false,
      message: `More than one app matches "${requestedName}": ${ambiguousCandidates.map((c) => c.displayName).join(', ')}.`,
      trace,
      ambiguousCandidates
    }
  }

  if (!selected) {
    return { ok: false, message: `"${requestedName}" doesn't look like an installed application.`, trace }
  }

  const outcome = await deps.launch(selected)

  if (outcome.status === 'failed') {
    trace.activationResult = { error: outcome.error }
    trace.finalResult = 'failed'
    return { ok: false, message: `Couldn't open ${selected.displayName}: ${outcome.error}`, trace }
  }

  trace.activationResult = 'ok'
  if (outcome.status === 'launched') {
    trace.observed = { pid: outcome.evidence.pid, processName: outcome.evidence.processName }
    trace.confidence = outcome.confidence
    trace.finalResult = 'launched'
    return { ok: true, message: `Opened ${selected.displayName}.`, trace }
  }

  // Accepted by the native launch call, but process observation couldn't
  // confirm it within the timeout — never reported as a failure, since
  // that's exactly the false-negative this architecture exists to remove.
  trace.confidence = 'unverified'
  trace.finalResult = 'accepted'
  return { ok: true, message: `Opening ${selected.displayName}.`, trace }
}
