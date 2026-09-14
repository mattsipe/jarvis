import os from 'os'
import { screen } from 'electron'
import { getPlatformControl } from '../platform'
import { jarvisHelper } from '../platform/helper'
import { loadPersistentContext, savePersistentContext } from './store'
import { readLocalHomeLocation, writeLocalHomeLocation } from './local'
import { memoryStore } from './memory'
import { operateContext } from '../operate/context'
import type { LiveContext, LocalHomeLocation, LocationResolution, PersistentContext } from './types'

export type { PersistentContext, LiveContext, LocationResolution } from './types'
export { memoryStore } from './memory'
export type { MemoryRecord, MemoryKind, MemorySource } from './memory'

/** Cheap live "what's on screen" fact injected into every turn — see buildSystemPromptContext(). Never a screenshot; see tools/perception.ts's look_at_screen for that. */
export interface ActiveWindowContext {
  title: string
  processName: string
  cursor: { x: number; y: number }
  /** Windows only (from the helper) — used by perception/capture.ts to crop an "active_window" screenshot. Unverified against non-100% display scaling; see capture.ts's comment. */
  bounds?: { x: number; y: number; width: number; height: number }
}

const SAVE_DEBOUNCE_MS = 1000

/**
 * Owns everything JARVIS knows about Weston and the current moment,
 * separate from the Agent (reasoning) and ToolRegistry (actions) — tools
 * read from it, the agent loop's system prompt is seeded from it, but
 * neither owns it. See the plan's Context Manager priority: persistent
 * facts (profile/preferences/location/devices/routines) vs live
 * facts (time/platform/active session/system telemetry), with location
 * resolved at general vs precise granularity depending on what a caller
 * actually needs (weather vs routing).
 */
export class ContextManager {
  private persistent: PersistentContext
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  readonly memory = memoryStore

  private sessionState = {
    commandCenterOpen: false,
    voiceSessionActive: false
  }

  constructor() {
    this.persistent = loadPersistentContext()
    if (!this.persistent.migratedToMemory) {
      this.memory.migrateFromPersistentContext(this.persistent)
      this.updatePersistent({ migratedToMemory: true })
    }
  }

  /** Active window + cursor, cheap enough to call every turn. Windows only for now — the helper has no macOS/dev equivalent yet (Phase 1 scope). */
  async getActiveWindow(): Promise<ActiveWindowContext | null> {
    if (process.platform !== 'win32') {
      const cursor = screen.getCursorScreenPoint()
      return { title: '', processName: '', cursor }
    }
    try {
      const fg = await jarvisHelper.foregroundWindow()
      return { title: fg.title, processName: fg.processName, cursor: fg.cursor, bounds: fg.bounds }
    } catch {
      return null
    }
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
    const activeWindow = await this.getActiveWindow()
    return [
      `Current time: ${live.nowIso} (${live.timeZone}).`,
      `Platform: ${live.platform}.`,
      `Weston's general location: ${general.label}.`,
      live.session.voiceSessionActive ? 'Talking with Weston now via voice.' : '',
      activeWindow?.title ? `Active window: "${activeWindow.title}" (${activeWindow.processName}).` : '',
      activeWindow ? `Cursor at (${activeWindow.cursor.x}, ${activeWindow.cursor.y}).` : '',
      operateContext.summary()
    ]
      .filter(Boolean)
      .join(' ')
  }

  /** Separate cache breakpoint from the persona and the per-turn context above — see agent/loop.ts and memory.ts's alwaysOnBlock(). */
  buildMemoryContext(): string {
    const block = this.memory.alwaysOnBlock()
    return block ? `What I remember about Weston: ${block}` : ''
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
