import { z } from 'zod'
import type { JarvisTool } from './registry'

export const openAppTool: JarvisTool = {
  name: 'open_app',
  description: 'Open/launch a desktop application by name.',
  risk: 'moderate',
  input: z.object({ name: z.string().describe('The application name, e.g. "Safari" or "Steam".') }),
  run: (input, ctx) => ctx.platform.openApp(input.name)
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
  description: 'Search installed applications by a partial name, to discover the exact name before opening/closing it.',
  risk: 'safe',
  input: z.object({ query: z.string().describe('Partial application name to search for.') }),
  run: (input, ctx) => ctx.platform.findApp(input.query)
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
  description: 'Launch a game through Steam, by Steam app ID if known or by name otherwise.',
  risk: 'moderate',
  input: z.object({ nameOrAppId: z.string().describe('The Steam app ID (preferred) or the game name.') }),
  run: (input, ctx) => ctx.platform.launchSteamGame(input.nameOrAppId)
}
