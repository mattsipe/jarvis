export interface ToolDiagnostics {
  /** Which platform adapter actually ran this — filled in by ToolRegistry.execute, not the adapter itself. */
  adapter?: 'darwin' | 'win32'
  startedAt?: number
  endedAt?: number
  durationMs?: number
  /** Underlying process exit code, when the failure came from spawning an external command. */
  exitCode?: number | null
  /** Captured stderr (or the closest equivalent), truncated — never secret material, just OS/PowerShell error text. */
  stderr?: string
}

export interface ToolResult {
  ok: boolean
  /** Short, speakable-ish summary — this is what Claude sees as the tool_result content. */
  message: string
  data?: Record<string, unknown>
  /** Never secret — see ToolDiagnostics. Powers Command Center's Recent Actions detail and the jarvis.log entry. */
  diagnostics?: ToolDiagnostics
  /** Set only by look_at_screen — turns this tool_result into an image block Claude can actually see. See agent/loop.ts's pruning of older screenshots. */
  images?: Array<{ mediaType: 'image/png' | 'image/jpeg'; base64: string }>
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
  /** Runs a battery of adapter-specific capability checks with no user-visible side effect — see the Command Center's "Run Self-Test". */
  selfTest(): Promise<ToolResult>
  /** All installed/launchable apps this adapter can enumerate — feeds apps/catalog.ts. Windows: Get-StartApps' {Name, AppID}. macOS: /Applications + ~/Applications, AppID === display name (launched via `open -a`). */
  listInstalledApps(): Promise<{ name: string; appId: string }[]>
  /** Launches a packaged/UWP app by its AppUserModelID (Windows: `PackageFamilyName!AppId`, e.g. new Outlook). Not meaningful on macOS. */
  launchByAppId(appId: string): Promise<ToolResult>
}

export class UnsupportedFeatureError extends Error {}

/** Standard "this isn't supported on this platform" result — fail clean, not silent. */
export function unsupported(feature: string, platform: string): ToolResult {
  return { ok: false, message: `${feature} isn't supported on ${platform} yet.` }
}
