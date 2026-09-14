import { z } from 'zod'
import type { JarvisTool } from './registry'
import { resolveApp, candidatesForLaunch } from '../apps/resolver'
import { getCatalog } from '../apps/catalog'
import { launchWithFallback, makePlatformLauncher } from '../apps/launcher'
import { logInfo } from '../logger'

export const openAppTool: JarvisTool = {
  name: 'open_app',
  description:
    'Open/launch a desktop application by name. Resolves aliases and installed apps (including packaged apps like new Outlook, and Steam games) automatically — if more than one installed app could match equally well, this returns candidates instead of guessing; ask Weston which one, then call remember (kind "alias") with his answer so it resolves cleanly next time.',
  risk: 'moderate',
  input: z.object({ name: z.string().describe('The application name, e.g. "Safari", "Steam", or "Outlook".') }),
  run: async (input, ctx) => {
    const resolution = resolveApp(input.name)
    // No catalog match at all (catalog empty/stale, or a name the catalog
    // genuinely doesn't have) — fall back to the adapter's own
    // best-effort direct launch rather than failing outright.
    if (!resolution) return ctx.platform.openApp(input.name)
    if ('ambiguous' in resolution) {
      return {
        ok: false,
        message: `More than one app matches "${input.name}": ${resolution.candidates.map((c) => c.displayName).join(', ')}. Ask which one, then remember the answer.`,
        data: { ambiguous: true, candidates: resolution.candidates }
      }
    }

    const candidates = candidatesForLaunch(resolution.entry)
    const { result, attempts, winningCandidate, usedFallback } = await launchWithFallback(candidates, makePlatformLauncher(ctx.platform))

    // Concise in Recent Actions (result.message, untouched); the full
    // requested-name → candidates → attempts → winner trail only ever
    // goes to the log — see windows.ts's class doc comment bug #4.
    logInfo(
      'apps:launch',
      `"${input.name}" candidates=[${candidates.map((c) => `${c.displayName}(${c.kind})`).join(', ')}] ` +
        `attempts=[${attempts.map((a) => `${a.displayName}:${a.ok ? 'ok' : 'fail'}`).join(', ')}] ` +
        `winner=${winningCandidate?.displayName ?? 'none'}`
    )

    // A fallback candidate is what actually worked, or the top-scored
    // candidate itself only matched because of a genuine ambiguity (not
    // the case here — this only runs post-disambiguation) — remember it
    // so the next launch for this exact name goes straight to what's
    // confirmed to work, same mechanism as "remember" (kind: "alias").
    if (usedFallback && winningCandidate) {
      ctx.context.memory.upsert({
        kind: 'alias',
        subject: input.name,
        content: winningCandidate.appId ?? winningCandidate.launchTarget,
        source: 'explicit'
      })
    }

    return { ...result, diagnostics: { ...result.diagnostics, launchAttempts: attempts } }
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
    const resolution = resolveApp(input.nameOrAppId)
    if (resolution && !('ambiguous' in resolution) && resolution.entry.kind === 'steam-game') {
      return ctx.platform.launchSteamGame(resolution.entry.appId ?? input.nameOrAppId)
    }
    if (resolution && 'ambiguous' in resolution) {
      return {
        ok: false,
        message: `More than one match for "${input.nameOrAppId}": ${resolution.candidates.map((c) => c.displayName).join(', ')}.`,
        data: { ambiguous: true, candidates: resolution.candidates }
      }
    }
    return ctx.platform.launchSteamGame(input.nameOrAppId)
  }
}
