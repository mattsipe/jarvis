import { toolRegistry } from './registry'
import { openAppTool, closeAppTool, findAppTool, focusWindowTool, launchSteamGameTool } from './apps'
import { setAppPreferenceTool } from './appPreference'
import { openUrlTool } from './web'
import {
  setVolumeTool,
  volumeUpTool,
  volumeDownTool,
  muteTool,
  unmuteTool,
  systemStatusTool,
  screenshotTool,
  selfTestTool
} from './system'
import { rememberTool, recallMemoryTool, updateMemoryTool, forgetMemoryTool } from './memory'
import { lookAtScreenTool } from './perception'
import { recordToolActivity } from './activity'
import { getPlatformControl } from '../platform'
import { contextManager } from '../context'
import type { ToolResult } from '../platform/types'

export { toolRegistry } from './registry'
export type { JarvisTool, RiskLevel, ToolContext, ToolResult } from './registry'

/** Registers the initial M3 tool set. Called once at startup — see main/index.ts. */
export function registerBuiltInTools(): void {
  for (const tool of [
    openAppTool,
    closeAppTool,
    findAppTool,
    focusWindowTool,
    launchSteamGameTool,
    setAppPreferenceTool,
    openUrlTool,
    setVolumeTool,
    volumeUpTool,
    volumeDownTool,
    muteTool,
    unmuteTool,
    systemStatusTool,
    screenshotTool,
    selfTestTool,
    rememberTool,
    recallMemoryTool,
    updateMemoryTool,
    forgetMemoryTool,
    lookAtScreenTool
  ]) {
    toolRegistry.register(tool)
  }
}

/**
 * Runs a registered tool outside of a voice turn — used by the Command
 * Center's "Run Self-Test" button (see ipc.ts's 'system:self-test'
 * handler) so diagnostics can be checked without speaking to JARVIS at
 * all. Goes through the exact same ToolRegistry.execute() path a
 * voice-triggered call would, so it gets identical diagnostics/logging,
 * and reuses recordToolActivity so the result shows up in the same Recent
 * Actions feed either way.
 */
export async function runToolStandalone(name: string, input: unknown = {}): Promise<ToolResult> {
  const ctx = { platform: getPlatformControl(), context: contextManager }
  const tool = toolRegistry.get(name)
  const risk = tool?.risk ?? 'safe'
  const id = `standalone-${name}-${Date.now()}`
  const timestamp = new Date().toISOString()

  recordToolActivity({ id, name, risk, input, status: 'started', timestamp })
  const result = await toolRegistry.execute(name, input, ctx)
  recordToolActivity({
    id,
    name,
    risk,
    input,
    status: result.ok ? 'success' : 'error',
    message: result.message,
    timestamp: new Date().toISOString(),
    diagnostics: result.diagnostics
  })
  return result
}
