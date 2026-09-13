import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import { logError } from '../logger'
import type { PlatformControl, SystemStatusInfo, ToolResult } from './types'

const execFileAsync = promisify(execFile)

/** Carries the process exit code and captured stderr through to the ToolResult — see failure() below. */
class PowerShellError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string
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
 * resolution of powershell.exe, exit code + stderr captured on every
 * failure, and a self-test tool that exercises each capability directly
 * (see selfTest()).
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
    const stderr = (e.stderr ?? '').trim()
    const exitCode = typeof e.code === 'number' ? e.code : null
    const spawnIssue = typeof e.code === 'string' ? e.code : null // e.g. 'ENOENT' (powershell.exe not found), 'ETIMEDOUT'
    const detail = stderr || (spawnIssue ? `spawn failed: ${spawnIssue}` : e.message)
    return new PowerShellError(detail.slice(0, 500), exitCode, stderr)
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
      logError('platform:windows', `${action} failed (exit ${err.exitCode ?? 'n/a'}): ${err.message}`)
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

  /** Resolves a display name (e.g. "Steam", "Chrome") to a Start Menu AppID via Get-StartApps. */
  private async resolveStartApp(name: string): Promise<{ name: string; appId: string } | null> {
    const script = `Get-StartApps | Where-Object { $_.Name -like ${this.psQuote(`*${name}*`)} } | Select-Object -First 1 | ConvertTo-Json -Compress`
    try {
      const out = await this.runPowerShell(script)
      if (!out) return null
      const parsed = JSON.parse(out) as { Name: string; AppID: string }
      return { name: parsed.Name, appId: parsed.AppID }
    } catch {
      return null
    }
  }

  async openApp(nameOrPath: string): Promise<ToolResult> {
    try {
      await this.runPowerShell(`Start-Process ${this.psQuote(nameOrPath)}`)
      return { ok: true, message: `Opened ${nameOrPath}.` }
    } catch (primaryErr) {
      const resolved = await this.resolveStartApp(nameOrPath)
      if (!resolved) return this.failure(`open "${nameOrPath}"`, primaryErr)
      try {
        // Get-StartApps' AppID for a real UWP/packaged app is
        // "PackageFamilyName!AppId" — only that form works with
        // shell:AppsFolder. For an ordinary desktop app (Chrome, Steam,
        // etc.) the AppID is a filesystem path to its shortcut/exe, and
        // shell:AppsFolder silently does nothing with a raw path — that
        // was the second real bug here. Launch it directly instead.
        const isPackagedAppId = /![^!]+$/.test(resolved.appId)
        if (isPackagedAppId) {
          await this.runPowerShell(`explorer.exe shell:AppsFolder\\${resolved.appId}`)
        } else {
          await this.runPowerShell(`Start-Process ${this.psQuote(resolved.appId)}`)
        }
        return { ok: true, message: `Opened ${resolved.name}.` }
      } catch (fallbackErr) {
        return this.failure(`launch ${resolved.name}`, fallbackErr)
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
   * quotes, which matters: see runAudioHelper() for why.
   */
  private static readonly AUDIO_HELPER_CSHARP = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f1(); int f2(); int f3(); int f4();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int f6();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int f8(); int f9(); int f10();
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
    const clamped = Math.max(0, Math.min(100, Math.round(percent))) / 100
    try {
      await this.runAudioHelper(
        `$v = [AudioHelper]::GetVolumeObject(); $v.SetMasterVolumeLevelScalar(${clamped}, [Guid]::Empty)`
      )
      return { ok: true, message: `Volume set to ${Math.round(clamped * 100)} percent.` }
    } catch (err) {
      return this.failure('set volume', err)
    }
  }

  async adjustVolume(deltaPercent: number): Promise<ToolResult> {
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

  async setMute(muted: boolean): Promise<ToolResult> {
    try {
      await this.runAudioHelper(
        `$v = [AudioHelper]::GetVolumeObject(); $v.SetMute($${muted ? 'true' : 'false'}, [Guid]::Empty)`
      )
      return { ok: true, message: muted ? 'Muted.' : 'Unmuted.' }
    } catch (err) {
      return this.failure('change mute state', err)
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
    try {
      // AppActivate returns a boolean rather than throwing when it can't
      // find a matching window — the previous version piped it to Out-Null
      // and unconditionally reported success, so a real "no such window"
      // case looked like it worked. Also: AppActivate matches on window
      // *title*, not process/app name, so "Chrome" won't match a window
      // titled "Some Page - Google Chrome" — surfaced explicitly below
      // rather than silently.
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
