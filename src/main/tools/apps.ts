import { z } from 'zod'
import type { JarvisTool } from './registry'
import { getCatalog } from '../apps/catalog'
import { rankCandidates, AMBIGUITY_MARGIN } from '../apps/rank'
import { launchAppByName, type LaunchAppDeps } from '../apps/launchApp'
import { appPreferences } from '../apps/preferencesStore'
import { logInfo } from '../logger'
import type { PlatformControl } from '../platform/types'
import type { InstalledApplication, LaunchOutcome } from '../apps/types'

/**
 * Dispatches a resolved catalog entry to the right primitive for its
 * kind — Steam entries go through the pre-existing, untouched
 * launchSteamGame path (adapted into the LaunchOutcome shape so the trace
 * stays uniform); everything else goes through the real native launch +
 * process-observation path (platform.launchInstalledApp).
 */
function createAppLauncher(platform: PlatformControl): (app: InstalledApplication) => Promise<LaunchOutcome> {
  return async (appEntry) => {
    if (appEntry.launchKind === 'steam-game') {
      const result = await platform.launchSteamGame(appEntry.appId)
      return result.ok ? { status: 'accepted', confidence: 'unverified' } : { status: 'failed', error: result.message }
    }
    return platform.launchInstalledApp(appEntry)
  }
}

export const openAppTool: JarvisTool = {
  name: 'open_app',
  description:
    'Open/launch a desktop application by name. Resolves installed apps (including packaged apps like new Outlook, Office, and Steam games) directly against what Windows itself has registered — if more than one installed app could match equally well, this returns real candidates (with their exact canonicalId) instead of guessing; ask Weston which one, then call set_app_preference with the candidate\'s canonicalId so it resolves cleanly next time.',
  risk: 'moderate',
  input: z.object({ name: z.string().describe('The application name, e.g. "Safari", "Steam", or "Outlook".') }),
  run: async (input, ctx) => {
    const deps: LaunchAppDeps = {
      getCatalog: () => getCatalog(),
      getPreference: (query) => appPreferences.get(query),
      launch: createAppLauncher(ctx.platform)
    }
    const { ok, message, trace, ambiguousCandidates } = await launchAppByName(input.name, deps)

    // Concise in Recent Actions (`message`, unchanged); the full
    // request → candidates → activation → observation trail always goes
    // to the log and rides along in diagnostics for the App Launch Lab —
    // see apps/types.ts's LaunchTrace doc comment for why this exists.
    logInfo('apps:launch', JSON.stringify(trace))

    return {
      ok,
      message,
      data: ambiguousCandidates
        ? { ambiguous: true, candidates: ambiguousCandidates.map((c) => ({ canonicalId: c.canonicalId, displayName: c.displayName })) }
        : undefined,
      diagnostics: { launchTrace: trace }
    }
  }
}

export const closeAppTool: JarvisTool = {
  name: 'close_app',
  description: 'Quit/close a running desktop application. Destructive if it has unsaved work — always confirm first.',
  risk: 'elevated',
  input: z.object({ name: z.string().describe('The application name to close.') }),
  run: (input, ctx) => ctx.platform.closeApp(input.name)
}

export const findAppTool: JarvisTool = {
  name: 'find_app',
  description: 'Search installed applications (and Steam games) by a partial name, to discover the exact name before opening/closing it.',
  risk: 'safe',
  input: z.object({ query: z.string().describe('Partial application name to search for.') }),
  run: async (input, ctx) => {
    const q = input.query.toLowerCase()
    const catalogMatches = getCatalog()
      .filter((e) => e.displayName.toLowerCase().includes(q))
      .map((e) => e.displayName)
    if (catalogMatches.length > 0) {
      return {
        ok: true,
        message: catalogMatches.length === 1 ? catalogMatches[0] : `Found: ${catalogMatches.slice(0, 8).join(', ')}.`,
        data: { matches: catalogMatches }
      }
    }
    // Catalog empty/stale — fall back to the adapter's own live search.
    return ctx.platform.findApp(input.query)
  }
}

export const focusWindowTool: JarvisTool = {
  name: 'focus_window',
  description: "Bring an already-running application's window to the front.",
  risk: 'moderate',
  input: z.object({ name: z.string().describe('The application name to switch to.') }),
  run: (input, ctx) => ctx.platform.focusWindow(input.name)
}

export const launchSteamGameTool: JarvisTool = {
  name: 'launch_steam_game',
  description: 'Launch a game through Steam, by name (resolved against the Steam library automatically) or app ID if known.',
  risk: 'moderate',
  input: z.object({ nameOrAppId: z.string().describe('The game name (preferred) or its Steam app ID.') }),
  run: async (input, ctx) => {
    const ranked = rankCandidates(input.nameOrAppId, getCatalog(), null)
    const top = ranked[0]
    if (top && top.app.launchKind === 'steam-game' && (ranked.length === 1 || top.score - ranked[1].score >= AMBIGUITY_MARGIN)) {
      return ctx.platform.launchSteamGame(top.app.appId)
    }
    if (ranked.length > 1 && top && top.score - ranked[1].score < AMBIGUITY_MARGIN) {
      return {
        ok: false,
        message: `More than one match for "${input.nameOrAppId}": ${ranked
          .slice(0, 4)
          .map((r) => r.app.displayName)
          .join(', ')}.`,
        data: { ambiguous: true, candidates: ranked.slice(0, 4).map((r) => r.app) }
      }
    }
    return ctx.platform.launchSteamGame(input.nameOrAppId)
  }
}
