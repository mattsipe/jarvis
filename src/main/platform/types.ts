import type { InstalledApplication, LaunchOutcome, LaunchTrace } from '../apps/types'
import type { ActionResult, ElementDetail, InspectResult, OperateTarget, WaitResult, WindowSummary } from '../operate/types'

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
  /** open_app's full resolution+launch record — see apps/types.ts's LaunchTrace and the App Launch Lab, which renders this directly. Kept out of `message`/Recent Actions (shown behind an expandable detail), always written to the log. */
  launchTrace?: LaunchTrace
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
  /**
   * Every installed/launchable app this adapter can enumerate, each
   * already carrying its own canonical launch identity — feeds
   * apps/catalog.ts, which is the ONLY place allowed to mint a
   * CanonicalAppId (see apps/types.ts). Windows: Get-StartApps' AppID is
   * already the exact string Windows itself uses to launch that entry
   * (a real path, or an AppsFolder parsing name/AUMID — Click-to-Run
   * Office apps and true UWP apps both fall in the latter category
   * despite looking nothing alike, which is why `launchKind` is derived
   * from Test-Path, not the string's shape). macOS: /Applications +
   * ~/Applications, launched via `open -a` (always `desktop-path`-like —
   * see darwin.ts).
   */
  listInstalledApps(): Promise<InstalledApplication[]>
  /**
   * Launches an already-resolved catalog entry and reports what actually
   * happened — never a raw string. See apps/types.ts's LaunchOutcome for
   * why "the native call succeeded but couldn't be confirmed" is
   * deliberately distinct from "it failed": only a real native/OS error
   * ever produces `{status:'failed'}`.
   */
  launchInstalledApp(app: InstalledApplication): Promise<LaunchOutcome>
  /**
   * Semantic UI Automation control (Operate) — `null` on a platform with
   * no UIA equivalent (macOS), which is also how tools/index.ts decides
   * whether to register the Operate tools at all, so Claude never even
   * sees them offered on a platform that can't back them (and never pays
   * their token cost either).
   */
  readonly operate: OperateControl | null
}

/**
 * The thin, typed surface tools/operate.ts calls through — see
 * operate/types.ts for the shared result shapes and the plan's "typed
 * tool contracts" section for why this stays a small, fixed set of
 * methods rather than exposing raw UIA. Windows implements this via
 * jarvis-helper.exe's Uia/*.cs; there is no macOS implementation.
 */
export interface OperateControl {
  inspect(params: {
    window?: string
    query?: string
    ref?: string
    at?: { x: number; y: number }
    maxElements?: number
  }): Promise<InspectResult | ElementDetail>
  act(params: {
    target: OperateTarget
    action: 'invoke' | 'toggle' | 'set_value' | 'select' | 'expand' | 'collapse' | 'focus' | 'scroll'
    desiredState?: 'on' | 'off'
    value?: string
    option?: string
    direction?: 'up' | 'down' | 'into_view'
    waitMs?: number
  }): Promise<ActionResult>
  wait(params: {
    condition: 'appears' | 'disappears' | 'state' | 'window_title'
    target?: OperateTarget
    state?: string
    titleContains?: string
    timeoutMs: number
  }): Promise<WaitResult>
  fingerprint(): Promise<WindowSummary>
  sendKeys(keys: string): Promise<void>
  sendText(text: string): Promise<void>
  pointer(params: { x: number; y: number; action: 'click' | 'double_click' | 'right_click' | 'scroll'; button?: 'left' | 'right'; scrollDelta?: number }): Promise<void>
}

export class UnsupportedFeatureError extends Error {}

/** Standard "this isn't supported on this platform" result — fail clean, not silent. */
export function unsupported(feature: string, platform: string): ToolResult {
  return { ok: false, message: `${feature} isn't supported on ${platform} yet.` }
}
