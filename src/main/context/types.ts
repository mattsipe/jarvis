import type { SystemStatusInfo } from '../platform/types'

/**
 * Durable, cross-session facts about Weston and how JARVIS should behave —
 * persisted to a single JSON file (per the plan's Persistence decision).
 * Deliberately a flat, permissive shape: new fields get added as tools
 * that consume them (weather, routing, calendar, ...) are built, without
 * a migration step, since this is a single-user local file, not a DB.
 */
export interface PersistentContext {
  userProfile: {
    name: string
    pronouns?: string
  }
  preferences: Record<string, unknown>
  /** Coarse, safe-to-commit-as-a-default location — weather/local search/etc. */
  generalLocation: {
    label: string
    lat?: number
    lon?: number
  }
  devices: string[]
  /** Spoken alias -> canonical app name/path, e.g. "steam" -> "Steam". */
  appAliases: Record<string, string>
  routines: Array<{ name: string; description: string }>
  /** Freeform bucket for anything JARVIS picks up during use that doesn't have a typed home yet. */
  learnedContext: Record<string, unknown>
}

export const DEFAULT_GENERAL_LOCATION = { label: 'Madison, Alabama 35756' }

export function defaultPersistentContext(): PersistentContext {
  return {
    userProfile: { name: 'Weston' },
    preferences: {},
    generalLocation: { ...DEFAULT_GENERAL_LOCATION },
    devices: [],
    appAliases: {},
    routines: [],
    learnedContext: {}
  }
}

/**
 * Precise home address, kept OUT of both git and the regular persistent
 * context file — see context/local.ts. Only ever read from local runtime
 * config, never hardcoded, never synced.
 */
export interface LocalHomeLocation {
  label: string
  lat?: number
  lon?: number
}

export interface LocationResolution {
  label: string
  lat?: number
  lon?: number
  source: 'home-precise' | 'os-location' | 'general-default'
}

/** Recomputed on demand each time it's asked for — never persisted itself. */
export interface LiveContext {
  nowIso: string
  timeZone: string
  platform: NodeJS.Platform
  hostname: string
  session: {
    commandCenterOpen: boolean
    voiceSessionActive: boolean
  }
  system: SystemStatusInfo | null
}
