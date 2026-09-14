import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import { logError, logInfo } from '../logger'
import { jarvisHelper } from './helper'
import { stripCliXml } from './cliXml'
import type { PlatformControl, SystemStatusInfo, ToolResult } from './types'

const execFileAsync = promisify(execFile)

/**
 * Carries the process exit code and captured stderr through to the
 * ToolResult — see failure() below. `stderr` is CLIXML-stripped (safe for
 * Recent Actions/Claude to see); `rawStderr` is untouched and only ever
 * reaches the log file, for the rare case the stripped summary isn't
 * enough to diagnose something.
 */
class PowerShellError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly rawStderr: string
  ) {
    super(message)
  }
}

/**
 * Windows adapter — the authoritative production target for JARVIS.
 *
 * Two real, confirmed bugs were found here after the first real-Windows
 * acceptance test reported every single action (open_app, focus_window,
 * set_volume, mute/unmute, screenshot) failing:
 *
 * 1. Every script was sent via `-Command "<script>"` as one argv element.
 *    That round-trips through Node's Windows argv encoding AND then
 *    PowerShell's own command-line tokenizer before PowerShell ever sees
 *    the actual script text — a well-known fragile path for anything with
 *    embedded quotes. `runPowerShell` now sends every script via
 *    `-EncodedCommand` (base64 UTF-16LE) instead, which hands PowerShell
 *    the exact bytes with no re-parsing step in between.
 * 2. The volume/mute inline-C# script embedded a double-quoted string and
 *    escaped its inner `"` characters with a backslash (`\"`) — but
 *    PowerShell string escaping uses a backtick, not a backslash. A bare
 *    `\` before `"` does not escape it, so the very first `[Guid("...")]`
 *    attribute in the C# closed the PowerShell string early and broke
 *    every volume/mute call with a parse error. Fixed by wrapping the C#
 *    in a *single*-quoted PowerShell string instead (it contains no
 *    apostrophes, so it needs no escaping at all).
 * 3. `openApp`'s AppID classification assumed only true UWP/packaged apps
 *    need `shell:AppsFolder` (detected by a `!` in the AppID) and every
 *    other AppID is a real filesystem path safe for `Start-Process`. A
 *    real-PC test with "open Excel" disproved that: Office's Click-to-Run
 *    AppIDs (`Microsoft.Office.EXCEL.EXE.15` and siblings for Word,
 *    PowerPoint, etc.) are neither `!`-shaped nor a real path — they only
 *    resolve through the same `shell:AppsFolder` activation Explorer uses
 *    for genuinely packaged apps. Fixed by asking Windows directly
 *    (`Test-Path` on the AppID) instead of guessing from its shape — see
 *    resolveStartApp() and apps/catalog.ts, which classifies the catalog
 *    the same way. Launches are now also verified (a new window actually
 *    appearing, via the helper's window list) rather than trusting that
 *    `shell:AppsFolder`/`Start-Process` returning success means the target
 *    really opened — `explorer.exe shell:AppsFolder\...` in particular can
 *    report success even when the target silently failed to activate.
 *
 * Everything else here is hardening so the next real-Windows run reports
 * an exact cause instead of a bare failure: explicit (non-PATH-dependent)
 * resolution of powershell.exe, exit code + CLIXML-stripped stderr
 * captured on every failure (see cliXml.ts — raw CLIXML must never reach
 * Recent Actions/Claude, only the log file), and a self-test tool that
 * exercises each capability directly (see selfTest()).
 *
 * 4. Real-PC testing then reported New Outlook resolving but failing to
 *    launch, treated as a regression from an earlier working release.
 *    Re-auditing the code found the same *class* of bug as #3 one layer
 *    up: apps/resolver.ts's alias lookup, when a previously-saved alias's
 *    target no longer matches anything in the current catalog snapshot
 *    (catalog staleness, or a rename upstream), fell back to treating the
 *    saved value as a literal path/exe name safe for Start-Process — but
 *    a saved AUMID-shaped alias (New Outlook's is a true UWP AUMID,
 *    "PackageFamilyName!App") is not a path either. Fixed in resolveApp()
 *    below by classifying the orphaned alias target by its own shape
 *    (contains `!`  → packaged) instead of assuming 'shortcut'. Launching
 *    itself was also hardened at the same time, generally rather than for
 *    Outlook specifically: openApp()/launchByAppId() now call
 *    jarvis-helper.exe's native launchExe/launchAumid (ProcessStartInfo/
 *    ShellExecute and the real IApplicationActivationManager COM API,
 *    respectively — see AppLauncher.cs) as the primary mechanism, since
 *    both give a real, specific success/failure signal instead of a shell
 *    exit code that only ever means "the command was accepted". PowerShell
 *    Start-Process/explorer.exe shell:AppsFolder remain the fallback only
 *    for when the helper itself isn't running. On top of that,
 *    apps/launcher.ts now tries more than one discovered candidate for the
 *    same requested name (e.g. an app registered both in Start Menu and in
 *    the App Paths registry) before giving up, and remembers whichever one
 *    actually worked as an alias so the next launch skips straight to it.
 */
export class WindowsPlatformControl implements PlatformControl {
  readonly name = 'win32' as const

  private static readonly POWERSHELL_PATH = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )

  /** Never trust PATH resolution alone for this — resolve the well-known system path first, PATH as a fallback only. */
  private resolvePowerShellExe(): string {
    try {
      return existsSync(WindowsPlatformControl.POWERSHELL_PATH) ? WindowsPlatformControl.POWERSHELL_PATH : 'powershell.exe'
    } catch {
      return 'powershell.exe'
    }
  }

  private toPowerShellError(err: unknown): PowerShellError {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string }
    const rawStderr = (e.stderr ?? '').trim()
    const stderr = stripCliXml(rawStderr)
    const exitCode = typeof e.code === 'number' ? e.code : null
    const spawnIssue = typeof e.code === 'string' ? e.code : null // e.g. 'ENOENT' (powershell.exe not found), 'ETIMEDOUT'
    const detail = stderr || (spawnIssue ? `spawn failed: ${spawnIssue}` : e.message)
    return new PowerShellError(detail.slice(0, 500), exitCode, stderr, rawStderr)
  }

  /** Every script goes through -EncodedCommand — see the class doc comment for why. */
  private async runPowerShell(script: string): Promise<string> {
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    try {
      const { stdout } = await execFileAsync(
        this.resolvePowerShellExe(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { timeout: 20000, maxBuffer: 10 * 1024 * 1024 }
      )
      return stdout.trim()
    } catch (err) {
      throw this.toPowerShellError(err)
    }
  }

  /** Standard single-quoted PowerShell string escaping (double any embedded `'`). */
  private psQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`
  }

  /** Shared failure path — logs the real cause and carries exit code/stderr into the ToolResult for Command Center + jarvis.log. */
  private failure(action: string, err: unknown): ToolResult {
    if (err instanceof PowerShellError) {
      // Full, unsanitized stderr only ever goes to the log file — Recent
      // Actions and Claude only ever see err.message/err.stderr, which are
      // already CLIXML-stripped (see toPowerShellError/stripCliXml).
      logError('platform:windows', `${action} failed (exit ${err.exitCode ?? 'n/a'}): ${err.rawStderr || err.message}`)
      return {
        ok: false,
        message: `Couldn't ${action}: ${err.message}`,
        diagnostics: { exitCode: err.exitCode, stderr: err.stderr || undefined }
      }
    }
    const message = err instanceof Error ? err.message : String(err)
    logError('platform:windows', `${action} failed: ${message}`)
    return { ok: false, message: `Couldn't ${action}: ${message}` }
  }

  /**
   * Resolves a display name (e.g. "Steam", "Chrome", "Excel") to a Start
   * Menu AppID via Get-StartApps, along with whether that AppID is
   * actually a real filesystem path — see the class doc comment's bug #3
   * for why this can't be inferred from the AppID's shape (a `!` in it)
   * alone.
   */
  private async resolveStartApp(name: string): Promise<{ name: string; appId: string; isPath: boolean } | null> {
    const script = `Get-StartApps | Where-Object { $_.Name -like ${this.psQuote(`*${name}*`)} } | Select-Object -First 1 -Property Name, AppID, @{Name='IsPath';Expression={ [bool](Test-Path -LiteralPath $_.AppID -ErrorAction SilentlyContinue) }} | ConvertTo-Json -Compress`
    try {
      const out = await this.runPowerShell(script)
      if (!out) return null
      const parsed = JSON.parse(out) as { Name: string; AppID: string; IsPath: boolean }
      return { name: parsed.Name, appId: parsed.AppID, isPath: parsed.IsPath }
    } catch {
      return null
    }
  }

  /**
   * Best-effort confirmation a launch actually resulted in a new window —
   * see the class doc comment's bug #3. `explorer.exe shell:AppsFolder\...`
   * in particular can report success (exit 0) even when the target
   * silently failed to activate, since the command is just handed off to
   * an already-running Explorer process asynchronously. Never turns a real
   * launch into a reported failure just because the app is slow to open a
   * window (some take a while, or start minimized/in the tray) — it only
   * softens an unqualified "Opened X" into an honest "sent the command,
   * but no new window showed up yet" when nothing appeared in time.
   */
  private async snapshotWindowHwnds(): Promise<Set<number>> {
    try {
      const { windows } = await jarvisHelper.listWindows()
      return new Set(windows.map((w) => w.hwnd))
    } catch {
      return new Set()
    }
  }

  /**
   * Packaged/UWP apps (New Outlook in particular — WebView2-based, often
   * slow on a cold start) get a longer verification window than a plain
   * exe. Never turns a real launch into a reported failure either way —
   * see the comment above — this only affects how long the softer
   * "no new window appeared yet" wording is deferred.
   */
  private static readonly PACKAGED_VERIFY_TIMEOUT_MS = 9000

  private async verifyNewWindowAppeared(beforeHwnds: Set<number>, timeoutMs = 4000): Promise<{ appeared: boolean; title?: string }> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try {
        const { windows } = await jarvisHelper.listWindows()
        const newWindow = windows.find((w) => !beforeHwnds.has(w.hwnd))
        if (newWindow) {
          logInfo('platform:windows', `launch verified: new window "${newWindow.title || newWindow.processName}"`)
          return { appeared: true, title: newWindow.title || newWindow.processName }
        }
      } catch {
        return { appeared: false } // helper unavailable — can't verify, don't block the result on it
      }
    }
    logInfo('platform:windows', `launch verification timed out after ${timeoutMs}ms — no new window seen (may just be slow to start)`)
    return { appeared: false }
  }

  /**
   * The real ShellExecute/CreateProcess mechanism via jarvis-helper.exe
   * (see AppLauncher.cs) — primary path, since unlike Start-Process it
   * throws a specific native reason on real failure. Falls back to
   * PowerShell Start-Process only when the helper genuinely isn't
   * running; if the helper IS running and the call itself throws, that's
   * a real failure and is allowed to propagate so the caller (a candidate
   * fallback loop, or this method's own catch) can react to it.
   */
  private async launchExeNative(target: string): Promise<void> {
    try {
      await jarvisHelper.launchExe(target)
    } catch (err) {
      if (jarvisHelper.isRunning()) throw err
      await this.runPowerShell(`Start-Process ${this.psQuote(target)}`)
    }
  }

  /** Same fallback shape as launchExeNative, for the AUMID activation API. */
  private async launchAumidNative(appId: string): Promise<void> {
    try {
      await jarvisHelper.launchAumid(appId)
    } catch (err) {
      if (jarvisHelper.isRunning()) throw err
      await this.runPowerShell(`explorer.exe shell:AppsFolder\\${appId}`)
    }
  }

  async openApp(nameOrPath: string): Promise<ToolResult> {
    const beforeHwnds = await this.snapshotWindowHwnds()
    try {
      await this.launchExeNative(nameOrPath)
      const verified = await this.verifyNewWindowAppeared(beforeHwnds)
      return verified.appeared
        ? { ok: true, message: `Opened ${nameOrPath}.` }
        : { ok: true, message: `Sent the command to open ${nameOrPath}, but no new window appeared yet — it may still be starting.` }
    } catch (primaryErr) {
      const resolved = await this.resolveStartApp(nameOrPath)
      if (!resolved) return this.failure(`open "${nameOrPath}"`, primaryErr)
      // Get-StartApps' AppID only works as a direct launch target when
      // it's a real filesystem path (an ordinary desktop shortcut/exe).
      // Anything else — a true UWP AppUserModelID ("PackageFamilyName!AppId")
      // *or* a Click-to-Run-style AppID that isn't `!`-shaped at all
      // (Office apps: "Microsoft.Office.EXCEL.EXE.15" and siblings are the
      // confirmed real-world case) — needs AUMID activation instead, the
      // same mechanism Explorer itself uses for both. Verified with
      // Test-Path rather than guessed from the AppID's shape.
      try {
        if (!resolved.isPath) await this.launchAumidNative(resolved.appId)
        else await this.launchExeNative(resolved.appId)
        const verified = await this.verifyNewWindowAppeared(
          beforeHwnds,
          resolved.isPath ? 4000 : WindowsPlatformControl.PACKAGED_VERIFY_TIMEOUT_MS
        )
        return verified.appeared
          ? { ok: true, message: `Opened ${resolved.name}.` }
          : { ok: true, message: `Sent the command to open ${resolved.name}, but no new window appeared yet — it may still be starting.` }
      } catch (fallbackErr) {
        return this.failure(`launch ${resolved.name}`, fallbackErr)
      }
    }
  }

  /** Launches a packaged/UWP/Click-to-Run app directly by its already-known AppUserModelID — used by apps/launcher.ts once an app has been catalogued, skipping the name-guessing openApp() above entirely. See the class doc comment's bugs #3 and #4. */
  async launchByAppId(appId: string): Promise<ToolResult> {
    const beforeHwnds = await this.snapshotWindowHwnds()
    try {
      await this.launchAumidNative(appId)
      const verified = await this.verifyNewWindowAppeared(beforeHwnds, WindowsPlatformControl.PACKAGED_VERIFY_TIMEOUT_MS)
      return verified.appeared
        ? { ok: true, message: `Opened ${verified.title ?? 'it'}.` }
        : { ok: true, message: 'Sent the command to open it, but no new window appeared yet — it may still be starting.' }
    } catch (err) {
      return this.failure('open that app', err)
    }
  }

  /**
   * Second discovery source for the app catalog, alongside Get-StartApps
   * below — the "App Paths" registry, which maps a friendly exe name
   * directly to a verified filesystem path (Test-Path-checked here, same
   * as the Start Menu source). Kept as genuinely separate candidate
   * entries rather than merged into the Start-Menu ones for the same
   * name, since this is what gives apps/launcher.ts an independent,
   * differently-launched fallback candidate for the same app — see the
   * class doc comment's bug #4. Best-effort: an empty/missing key (or a
   * PowerShell failure) just means the catalog falls back to Start Menu
   * alone, which was already a complete, correct catalog before this was
   * added.
   */
  private async listAppPathsEntries(): Promise<{ name: string; appId: string; isPath: boolean }[]> {
    const script = `
Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue).'(default)'
  if ($p -and (Test-Path -LiteralPath $p -ErrorAction SilentlyContinue)) {
    [pscustomobject]@{ Name = ($_.PSChildName -replace '\\.exe$',''); AppID = $p; IsPath = $true }
  }
} | ConvertTo-Json -Compress
`.replace(/\r?\n/g, ' ')
    try {
      const out = await this.runPowerShell(script)
      if (!out) return []
      const parsed = JSON.parse(out) as { Name: string; AppID: string; IsPath: boolean } | { Name: string; AppID: string; IsPath: boolean }[]
      const list = Array.isArray(parsed) ? parsed : [parsed]
      return list.map((e) => ({ name: e.Name, appId: e.AppID, isPath: e.IsPath }))
    } catch {
      return []
    }
  }

  /**
   * Full app catalog (name + raw AppID + whether that AppID is a real
   * filesystem path, for every entry) — see apps/catalog.ts, which uses
   * `isPath` (not the AppID's shape) to decide how each app needs to be
   * launched. Merges Get-StartApps with the App Paths registry above,
   * deduped only on an exact (name, target) match so a genuinely
   * different candidate for the same display name (e.g. a Start-Menu
   * AUMID alongside an App-Paths exe) survives as a separate entry.
   * Distinct from resolveStartApp(), which only needs the first
   * Start-Menu match for the openApp() fallback above.
   */
  async listInstalledApps(): Promise<{ name: string; appId: string; isPath: boolean }[]> {
    const out = await this.runPowerShell(
      "Get-StartApps | Select-Object Name, AppID, @{Name='IsPath';Expression={ [bool](Test-Path -LiteralPath $_.AppID -ErrorAction SilentlyContinue) }} | ConvertTo-Json -Compress"
    )
    const parsed = out
      ? (JSON.parse(out) as { Name: string; AppID: string; IsPath: boolean } | { Name: string; AppID: string; IsPath: boolean }[])
      : []
    const startMenu = (Array.isArray(parsed) ? parsed : [parsed]).map((e) => ({ name: e.Name, appId: e.AppID, isPath: e.IsPath }))

    const appPaths = await this.listAppPathsEntries()
    const seen = new Set(startMenu.map((e) => `${e.name.toLowerCase()}|${e.appId}`))
    for (const entry of appPaths) {
      const key = `${entry.name.toLowerCase()}|${entry.appId}`
      if (!seen.has(key)) {
        seen.add(key)
        startMenu.push(entry)
      }
    }
    return startMenu
  }

  async closeApp(name: string): Promise<ToolResult> {
    const processName = name.replace(/\.exe$/i, '')
    try {
      await this.runPowerShell(`Stop-Process -Name ${this.psQuote(processName)} -Force -ErrorAction Stop`)
      return { ok: true, message: `Closed ${name}.` }
    } catch (err) {
      return this.failure(`close ${name}`, err)
    }
  }

  async openUrl(url: string): Promise<ToolResult> {
    try {
      await this.runPowerShell(`Start-Process ${this.psQuote(url)}`)
      return { ok: true, message: `Opened ${url}.` }
    } catch (err) {
      return this.failure('open that URL', err)
    }
  }

  /**
   * Core Audio (IAudioEndpointVolume) via inline C#, per the plan's risk
   * mitigation — no nircmd or other external binary. Contains no single
   * quotes, which matters: see runAudioHelper() for why. This is now only
   * the fallback path if jarvis-helper.exe (see platform/helper.ts) isn't
   * running — the helper's Audio.cs is the primary implementation.
   *
   * The vtable below previously had an off-by-one: it was missing the
   * placeholder for GetChannelVolumeLevelScalar (real vtable slot 13,
   * counting from 3 since the 3 IUnknown slots are implicit under
   * InterfaceIsIUnknown). That made the declared "SetMute" actually land
   * on slot 13 (the real GetChannelVolumeLevelScalar) and "GetMute" land
   * on slot 14 (the real SetMute) — calling the wrong native methods
   * entirely with mismatched argument types. Every slot is listed
   * explicitly now so the count can't drift silently again.
   */
  private static readonly AUDIO_HELPER_CSHARP = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int RegisterControlChangeNotify_NotUsed();
  int UnregisterControlChangeNotify_NotUsed();
  int GetChannelCount_NotUsed();
  int SetMasterVolumeLevel_NotUsed();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int GetMasterVolumeLevel_NotUsed();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int SetChannelVolumeLevel_NotUsed();
  int SetChannelVolumeLevelScalar_NotUsed();
  int GetChannelVolumeLevel_NotUsed();
  int GetChannelVolumeLevelScalar_NotUsed();
  int SetMute(bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class AudioHelper {
  public static IAudioEndpointVolume GetVolumeObject() {
    var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev; enumerator.GetDefaultAudioEndpoint(0, 1, out dev);
    Guid IID_IAudioEndpointVolume = typeof(IAudioEndpointVolume).GUID;
    IAudioEndpointVolume epv; dev.Activate(ref IID_IAudioEndpointVolume, 23, IntPtr.Zero, out epv);
    return epv;
  }
}`.replace(/\r?\n/g, ' ')

  private async runAudioHelper(action: string): Promise<string> {
    // Single-quoted, not double-quoted: the C# text has no apostrophes, so
    // this needs zero escaping. The previous version double-quoted this and
    // backslash-escaped the C# attributes' inner quotes (\") — but
    // PowerShell doesn't treat \ as a string-escape character, so that
    // closed the PowerShell string early and broke every volume/mute call.
    return this.runPowerShell(`Add-Type -TypeDefinition '${WindowsPlatformControl.AUDIO_HELPER_CSHARP}'; ${action}`)
  }

  async setVolume(percent: number): Promise<ToolResult> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    try {
      // jarvis-helper.exe is the primary path — no per-call PowerShell
      // startup or Add-Type compile. It lazily starts itself on first
      // call; if it can't start or the call fails, fall back to the
      // inline-C# PowerShell path (also vtable-fixed, see
      // AUDIO_HELPER_CSHARP) so volume control never hard-depends on it.
      const result = await jarvisHelper.audioSetVolume(clamped)
      return { ok: true, message: `Volume set to ${result.volumePercent} percent.` }
    } catch {
      try {
        await this.runAudioHelper(`$v = [AudioHelper]::GetVolumeObject(); $v.SetMasterVolumeLevelScalar(${clamped / 100}, [Guid]::Empty)`)
        return { ok: true, message: `Volume set to ${clamped} percent.` }
      } catch (err) {
        return this.failure('set volume', err)
      }
    }
  }

  async adjustVolume(deltaPercent: number): Promise<ToolResult> {
    try {
      const current = (await jarvisHelper.audioGet()).volumePercent
      return this.setVolume(current + deltaPercent)
    } catch {
      try {
        const out = await this.runAudioHelper(
          `$v = [AudioHelper]::GetVolumeObject(); $cur = 0; $v.GetMasterVolumeLevelScalar([ref]$cur); Write-Output ([Math]::Round($cur * 100))`
        )
        const current = parseInt(out, 10)
        return this.setVolume((Number.isFinite(current) ? current : 50) + deltaPercent)
      } catch (err) {
        return this.failure('adjust volume', err)
      }
    }
  }

  async setMute(muted: boolean): Promise<ToolResult> {
    try {
      await jarvisHelper.audioSetMute(muted)
      return { ok: true, message: muted ? 'Muted.' : 'Unmuted.' }
    } catch {
      try {
        await this.runAudioHelper(`$v = [AudioHelper]::GetVolumeObject(); $v.SetMute($${muted ? 'true' : 'false'}, [Guid]::Empty)`)
        return { ok: true, message: muted ? 'Muted.' : 'Unmuted.' }
      } catch (err) {
        return this.failure('change mute state', err)
      }
    }
  }

  async getSystemStatus(): Promise<SystemStatusInfo> {
    let batteryPct: number | null = null
    try {
      const out = await this.runPowerShell(
        '(Get-CimInstance -ClassName Win32_Battery | Select-Object -First 1 -ExpandProperty EstimatedChargeRemaining)'
      )
      const parsed = parseInt(out, 10)
      batteryPct = Number.isFinite(parsed) ? parsed : null
    } catch {
      batteryPct = null
    }
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    return {
      platform: 'Windows',
      hostname: os.hostname(),
      uptimeSec: os.uptime(),
      cpuLoad1m: os.loadavg()[0] ?? 0, // Node reports 0 on Windows — see the Windows-build verification notes.
      memUsedPct: ((totalMem - freeMem) / totalMem) * 100,
      memTotalGB: totalMem / 1024 ** 3,
      batteryPct
    }
  }

  async screenshot(): Promise<ToolResult> {
    const filePath = join(app.getPath('pictures'), `jarvis-${Date.now()}.png`)
    const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
$bmp.Save(${this.psQuote(filePath)}, [System.Drawing.Imaging.ImageFormat]::Png);
`.replace(/\r?\n/g, ' ')
    try {
      await this.runPowerShell(script)
      return { ok: true, message: 'Screenshot captured.', data: { filePath } }
    } catch (err) {
      return this.failure('take a screenshot', err)
    }
  }

  async findApp(query: string): Promise<ToolResult> {
    const script = `Get-StartApps | Where-Object { $_.Name -like ${this.psQuote(`*${query}*`)} } | Select-Object -ExpandProperty Name`
    try {
      const out = await this.runPowerShell(script)
      const matches = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      if (matches.length === 0) return { ok: false, message: `No installed app matches "${query}".` }
      return {
        ok: true,
        message: matches.length === 1 ? matches[0] : `Found: ${matches.slice(0, 8).join(', ')}.`,
        data: { matches }
      }
    } catch (err) {
      return this.failure('search installed apps', err)
    }
  }

  async launchSteamGame(nameOrAppId: string): Promise<ToolResult> {
    const isNumeric = /^\d+$/.test(nameOrAppId.trim())
    try {
      if (isNumeric) {
        await this.runPowerShell(`Start-Process ${this.psQuote(`steam://rungameid/${nameOrAppId.trim()}`)}`)
        return { ok: true, message: 'Launching that game via Steam.' }
      }
      await this.runPowerShell(`Start-Process steam`)
      return {
        ok: true,
        message: `Opened Steam — I don't have a Steam app ID for "${nameOrAppId}" yet, so you'll need to launch it from the library.`
      }
    } catch (err) {
      return this.failure('launch Steam', err)
    }
  }

  async focusWindow(appName: string): Promise<ToolResult> {
    // Primary path: the helper's own window list, matched by title OR
    // process name (substring, case-insensitive) — this is what fixes
    // "focus Chrome" actually finding a window titled "Some Page - Google
    // Chrome" (process name "chrome"), which AppActivate's title-only,
    // options-free matching couldn't reliably do.
    try {
      const { windows } = await jarvisHelper.listWindows()
      const q = appName.toLowerCase()
      const match =
        windows.find((w) => w.processName.toLowerCase() === q) ??
        windows.find((w) => w.title.toLowerCase().includes(q) || w.processName.toLowerCase().includes(q))
      if (!match) return { ok: false, message: `No open window matches "${appName}".` }
      const { focused } = await jarvisHelper.focusWindow(match.hwnd)
      if (focused) return { ok: true, message: `Switched to ${match.title || match.processName}.` }
      return { ok: false, message: `Found "${match.title || match.processName}" but couldn't bring it to the front.` }
    } catch {
      // Fallback: AppActivate returns a boolean rather than throwing when
      // it can't find a matching window — a previous version piped it to
      // Out-Null and unconditionally reported success, so a real "no such
      // window" case looked like it worked. Also: AppActivate matches on
      // window *title*, not process/app name, so "Chrome" won't match a
      // window titled "Some Page - Google Chrome" (the helper path above
      // fixes that; this is only reached if the helper itself is down).
      try {
        const out = await this.runPowerShell(
          `if ((New-Object -ComObject WScript.Shell).AppActivate(${this.psQuote(appName)})) { Write-Output 'ACTIVATED' } else { Write-Output 'NOT_FOUND' }`
        )
        if (out.trim() === 'ACTIVATED') return { ok: true, message: `Switched to ${appName}.` }
        return {
          ok: false,
          message: `No open window matches "${appName}" — try the exact window title text, since this matches titles, not app names.`
        }
      } catch (err) {
        return this.failure(`switch to ${appName}`, err)
      }
    }
  }

  /**
   * Exercises every capability independently with no lasting side effect —
   * powers the Command Center's "Run Self-Test" button (also callable by
   * voice: "run a self test"). Each check reports its own pass/fail and
   * message rather than the whole thing failing on the first problem, so a
   * single real-Windows run pinpoints exactly which layer is broken.
   */
  async selfTest(): Promise<ToolResult> {
    const checks: Array<{ name: string; ok: boolean; message: string }> = []

    const run = async (name: string, fn: () => Promise<string>): Promise<void> => {
      try {
        const out = await fn()
        checks.push({ name, ok: true, message: out || 'ok' })
      } catch (err) {
        const message =
          err instanceof PowerShellError ? `${err.message} (exit ${err.exitCode ?? 'n/a'})` : err instanceof Error ? err.message : String(err)
        checks.push({ name, ok: false, message })
      }
    }

    await run('powershell-invocation', () => this.runPowerShell('Write-Output OK'))
    await run('start-apps-enumeration', async () => `${await this.runPowerShell('(Get-StartApps | Measure-Object).Count')} apps discoverable`)
    await run('helper-process', async () => {
      await jarvisHelper.ping()
      return 'jarvis-helper.exe responding'
    })
    await run('helper-foreground-window', async () => {
      const fg = await jarvisHelper.foregroundWindow()
      return `active window: ${fg.title || fg.processName || '(none)'}`
    })
    await run('helper-audio', async () => {
      const { volumePercent, muted } = await jarvisHelper.audioGet()
      return `current volume ${volumePercent}%${muted ? ' (muted)' : ''}`
    })
    await run('wscript-shell-com', async () => {
      await this.runPowerShell('(New-Object -ComObject WScript.Shell) | Out-Null')
      return 'created'
    })
    await run('audio-endpoint-inline-csharp', async () => {
      const out = await this.runAudioHelper(
        '$v = [AudioHelper]::GetVolumeObject(); $cur = 0; $v.GetMasterVolumeLevelScalar([ref]$cur); Write-Output ([Math]::Round($cur * 100))'
      )
      return `current volume ~${out}%`
    })
    await run('screenshot-capability', async () => {
      const testPath = join(app.getPath('temp'), `jarvis-selftest-${Date.now()}.png`)
      const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;
$g = [System.Drawing.Graphics]::FromImage($bmp);
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);
$bmp.Save(${this.psQuote(testPath)}, [System.Drawing.Imaging.ImageFormat]::Png);
Remove-Item ${this.psQuote(testPath)} -ErrorAction SilentlyContinue;
`.replace(/\r?\n/g, ' ')
      await this.runPowerShell(script)
      return 'captured and cleaned up'
    })

    const failed = checks.filter((c) => !c.ok)
    return {
      ok: failed.length === 0,
      message:
        failed.length === 0
          ? `All ${checks.length} Windows self-tests passed.`
          : `${failed.length} of ${checks.length} Windows self-tests failed: ${failed.map((c) => c.name).join(', ')}.`,
      data: { checks }
    }
  }
}
