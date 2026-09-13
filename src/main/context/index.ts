import os from 'os'
import { getPlatformControl } from '../platform'
import { loadPersistentContext, savePersistentContext } from './store'
import { readLocalHomeLocation, writeLocalHomeLocation } from './local'
import type { LiveContext, LocalHomeLocation, LocationResolution, PersistentContext } from './types'

export type { PersistentContext, LiveContext, LocationResolution } from './types'

const SAVE_DEBOUNCE_MS = 1000

/**
 * Owns everything JARVIS knows about Weston and the current moment,
 * separate from the Agent (reasoning) and ToolRegistry (actions) — tools
 * read from it, the agent loop's system prompt is seeded from it, but
 * neither owns it. See the plan's Context Manager priority: persistent
 * facts (profile/preferences/location/devices/aliases/routines) vs live
 * facts (time/platform/active session/system telemetry), with location
 * resolved at general vs precise granularity depending on what a caller
 * actually needs (weather vs routing).
 */
export class ContextManager {
  private persistent: PersistentContext
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  private sessionState = {
    commandCenterOpen: false,
    voiceSessionActive: false
  }

  constructor() {
    this.persistent = loadPersistentContext()
  }

  getPersistent(): PersistentContext {
    return this.persistent
  }

  updatePersistent(patch: Partial<PersistentContext>): void {
    this.persistent = { ...this.persistent, ...patch }
    this.scheduleSave()
  }

  setCommandCenterOpen(open: boolean): void {
    this.sessionState.commandCenterOpen = open
  }

  setVoiceSessionActive(active: boolean): void {
    this.sessionState.voiceSessionActive = active
  }

  async getLiveContext(includeSystemStatus = true): Promise<LiveContext> {
    return {
      nowIso: new Date().toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      platform: process.platform,
      hostname: os.hostname(),
      session: { ...this.sessionState },
      system: includeSystemStatus ? await getPlatformControl().getSystemStatus() : null
    }
  }

  /**
   * Location precision is deliberately intentional, not "always precise":
   * general-purpose asks (weather, "restaurants nearby") only need
   * `'general'`; anything requiring an actual route/distance should ask
   * for `'precise'`, which falls back to the general default if no local
   * home config has been set. A future Windows Location Services provider
   * can override the home location here without callers changing at all.
   */
  async resolveLocation(purpose: 'general' | 'precise'): Promise<LocationResolution> {
    if (purpose === 'precise') {
      const home = await readLocalHomeLocation()
      if (home) return { label: home.label, lat: home.lat, lon: home.lon, source: 'home-precise' }
    }
    const { generalLocation } = this.persistent
    return { label: generalLocation.label, lat: generalLocation.lat, lon: generalLocation.lon, source: 'general-default' }
  }

  async setHomeLocation(location: LocalHomeLocation): Promise<void> {
    await writeLocalHomeLocation(location)
  }

  /** Short, cheap-to-read summary injected into the agent's system prompt each turn — see agent/loop.ts. */
  async buildSystemPromptContext(): Promise<string> {
    const live = await this.getLiveContext(false)
    const general = await this.resolveLocation('general')
    return [
      `Current time: ${live.nowIso} (${live.timeZone}).`,
      `Platform: ${live.platform}.`,
      `Weston's general location: ${general.label}.`,
      live.session.voiceSessionActive ? 'Talking with Weston now via voice.' : ''
    ]
      .filter(Boolean)
      .join(' ')
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      savePersistentContext(this.persistent)
      this.saveTimer = null
    }, SAVE_DEBOUNCE_MS)
  }
}

export const contextManager = new ContextManager()
