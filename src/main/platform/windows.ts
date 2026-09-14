import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import { logError } from '../logger'
import { jarvisHelper } from './helper'
import { stripCliXml } from './cliXml'
import { mintCanonicalId, type InstalledApplication, type LaunchOutcome } from '../apps/types'
import { WindowsOperateControl } from './operateWindows'
import type { OperateControl, PlatformControl, SystemStatusInfo, ToolResult } from './types'

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
 *
 * Everything else here is hardening so the next real-Windows run reports
 * an exact cause instead of a bare failure: explicit (non-PATH-dependent)
 * resolution of powershell.exe, exit code + CLIXML-stripped stderr
 * captured on every failure (see cliXml.ts — raw CLIXML must never reach
 * Recent Actions/Claude, only the log file), and a self-test tool that
 * exercises each capability directly (see selfTest()).
 *
 * App launching was rebuilt from first principles after three rounds of
 * per-symptom patches (Excel's Click-to-Run AppID, then New Outlook)
 * still didn't hold up on a real PC — see the plan's root-cause writeup.
 * The actual causes were: (a) a natural-language app *preference*
 * ("Outlook means new Outlook, not classic") had no type boundary
 * stopping it from being launched as a literal string once saved to
 * memory — fixed by removing memory/aliases from the launch path
 * entirely (see apps/launchApp.ts, apps/preferences.ts); (b)
 * `IApplicationActivationManager`, the wrong activation contract for a
 * desktop/Click-to-Run app, could block the single-threaded helper long
 * enough to time out — fixed by using plain ShellExecute on the
 * `shell:AppsFolder\<id>` virtual path instead (see AppLauncher.cs), and
 * by dispatching every helper request on its own thread (Program.cs) so
 * one slow call can never block another; (c) verification watched for
 * "any new window", which misses an app (like Office) reusing an already-
 * running instance and can't tell one app's launch from another's —
 * fixed by watching for the expected *process* instead, by image name or
 * AppUserModelID (see ProcessObserver.cs). `listInstalledApps()` now
 * returns fully-formed `InstalledApplication` records (apps/types.ts) and
 * `launchInstalledApp()` takes one of those records, never a raw string —
 * see platform/types.ts's PlatformControl for why.
 */
export class WindowsPlatformControl implements PlatformControl {
  readonly name = 'win32' as const
  readonly operate: OperateControl = new WindowsOperateControl()

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
   * The full app catalog, straight from the OS's own registration — every
   * entry's AppID is already exactly what Windows uses internally to
   * launch it, so `canonicalId`/`appId` here are simply that string,
   * never guessed or reconstructed. `isPath` (via Test-Path) is the only
   * thing that has to be asked of Windows rather than read directly, and
   * it's asked here, not inferred from the string's shape — a real UWP
   * AppUserModelID and a Click-to-Run Office AppID
   * ("Microsoft.Office.EXCEL.EXE.15") look nothing alike but both need
   * the same non-path (`aumid`) launch treatment. See apps/catalog.ts,
   * which is the only place these get turned into `InstalledApplication`
   * records with a minted `CanonicalAppId`.
   */
  async listInstalledApps(): Promise<InstalledApplication[]> {
    const out = await this.runPowerShell(
      "Get-StartApps | Select-Object Name, AppID, @{Name='IsPath';Expression={ [bool](Test-Path -LiteralPath $_.AppID -ErrorAction SilentlyContinue) }} | ConvertTo-Json -Compress"
    )
    if (!out) return []
    const parsed = JSON.parse(out) as { Name: string; AppID: string; IsPath: boolean } | { Name: string; AppID: string; IsPath: boolean }[]
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.map((e) => ({
      canonicalId: mintCanonicalId(e.AppID),
      displayName: e.Name,
      registrationSource: 'appsfolder' as const,
      launchKind: e.IsPath ? ('desktop-path' as const) : ('aumid' as const),
      appId: e.AppID
    }))
  }

  /**
   * Launches an already-resolved catalog entry via jarvis-helper.exe's
   * native launchInstalledApp (real ShellExecute, plus process-identity
   * observation — see helper.ts and AppLauncher.cs/ProcessObserver.cs).
   * Only a real native/helper error becomes `{status:'failed'}`; the
   * helper genuinely not running at all falls back to a best-effort
   * PowerShell launch with no observation available (`unverified`) rather
   * than failing outright.
   */
  async launchInstalledApp(appEntry: InstalledApplication): Promise<LaunchOutcome> {
    const isPath = appEntry.launchKind === 'desktop-path'
    try {
      const result = await jarvisHelper.launchInstalledApp({ target: appEntry.appId, isPath, observeTimeoutMs: 8000 })
      if (result.confidence === 'unverified' || result.pid == null || result.processName == null) {
        return { status: 'accepted', confidence: 'unverified' }
      }
      return { status: 'launched', confidence: result.confidence, evidence: { pid: result.pid, processName: result.processName } }
    } catch (err) {
      if (jarvisHelper.isRunning()) {
        return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
      }
      // Helper isn't running at all — best-effort PowerShell fallback,
      // with no process observation available (the whole point of the
      // helper), so the outcome is honestly reported as unverified rather
      // than claiming confirmation we don't have.
      try {
        if (isPath) await this.runPowerShell(`Start-Process ${this.psQuote(appEntry.appId)}`)
        else await this.runPowerShell(`explorer.exe ${this.psQuote(`shell:AppsFolder\\${appEntry.appId}`)}`)
        return { status: 'accepted', confidence: 'unverified' }
      } catch (fallbackErr) {
        const message =
          fallbackErr instanceof PowerShellError ? fallbackErr.message : fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
        return { status: 'failed', error: message }
      }
    }
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
