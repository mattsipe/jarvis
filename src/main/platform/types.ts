export interface ToolResult {
  ok: boolean
  /** Short, speakable-ish summary — this is what Claude sees as the tool_result content. */
  message: string
  data?: Record<string, unknown>
}

export interface SystemStatusInfo {
  platform: string
  hostname: string
  uptimeSec: number
  cpuLoad1m: number
  memUsedPct: number
  memTotalGB: number
  batteryPct: number | null
}

/**
 * Thin cross-platform surface for real OS actions. Windows is the
 * authoritative production adapter (windows.ts); darwin.ts exists so the
 * full vertical slice can be built and tested on this machine. Every
 * method must fail cleanly (return `{ ok: false, message }`, never throw
 * past the tool boundary) when a feature genuinely isn't supported on a
 * platform, rather than silently doing nothing.
 */
export interface PlatformControl {
  readonly name: 'darwin' | 'win32'
  openApp(nameOrPath: string): Promise<ToolResult>
  closeApp(name: string): Promise<ToolResult>
  openUrl(url: string): Promise<ToolResult>
  setVolume(percent: number): Promise<ToolResult>
  adjustVolume(deltaPercent: number): Promise<ToolResult>
  setMute(muted: boolean): Promise<ToolResult>
  getSystemStatus(): Promise<SystemStatusInfo>
  screenshot(): Promise<ToolResult>
  findApp(query: string): Promise<ToolResult>
  launchSteamGame(nameOrAppId: string): Promise<ToolResult>
  focusWindow(appName: string): Promise<ToolResult>
}

export class UnsupportedFeatureError extends Error {}

/** Standard "this isn't supported on this platform" result — fail clean, not silent. */
export function unsupported(feature: string, platform: string): ToolResult {
  return { ok: false, message: `${feature} isn't supported on ${platform} yet.` }
}
