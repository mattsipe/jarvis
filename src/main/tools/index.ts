import { toolRegistry } from './registry'
import { openAppTool, closeAppTool, findAppTool, focusWindowTool, launchSteamGameTool } from './apps'
import { openUrlTool } from './web'
import { setVolumeTool, volumeUpTool, volumeDownTool, muteTool, unmuteTool, systemStatusTool, screenshotTool } from './system'

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
    openUrlTool,
    setVolumeTool,
    volumeUpTool,
    volumeDownTool,
    muteTool,
    unmuteTool,
    systemStatusTool,
    screenshotTool
  ]) {
    toolRegistry.register(tool)
  }
}
