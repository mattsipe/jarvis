import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import type { PlatformControl, SystemStatusInfo, ToolResult } from './types'

const execFileAsync = promisify(execFile)

/**
 * Windows adapter — the authoritative production target for JARVIS, but
 * written and never run on real Windows (this project is developed on
 * macOS). Every method here is a best-effort implementation using
 * documented/structured approaches (Start-Process, Get-StartApps, Core
 * Audio via inline C# — no external binaries like nircmd, per the
 * project's plan). **All of it needs verification on a real Windows
 * machine** — see the M3/Windows-build report for the exact checklist.
 */
export class WindowsPlatformControl implements PlatformControl {
  readonly name = 'win32' as const

  private async runPowerShell(script: string): Promise<string> {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script
    ])
    return stdout.trim()
  }

  private psQuote(s: string): string {
    return `'${s.replace(/'/g, "''")}'`
  }

  /** Resolves a display name (e.g. "Steam", "Notepad") to a Start Menu AppID via Get-StartApps. */
  private async resolveStartApp(name: string): Promise<{ name: string; appId: string } | null> {
    const script = `Get-StartApps | Where-Object { $_.Name -like '*${name.replace(/'/g, "''")}*' } | Select-Object -First 1 | ConvertTo-Json -Compress`
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
    } catch {
      // Fall back to Start Menu resolution for a display name that isn't
      // directly launchable (not on PATH, not a full exe path).
      const resolved = await this.resolveStartApp(nameOrPath)
      if (!resolved) {
        return { ok: false, message: `Couldn't find or launch "${nameOrPath}".` }
      }
      try {
        await this.runPowerShell(
          `explorer.exe shell:AppsFolder\\${resolved.appId.replace(/"/g, '')}`
        )
        return { ok: true, message: `Opened ${resolved.name}.` }
      } catch (err) {
        return { ok: false, message: `Couldn't launch ${resolved.name}: ${(err as Error).message}` }
      }
    }
  }

  async closeApp(name: string): Promise<ToolResult> {
    const processName = name.replace(/\.exe$/i, '')
    try {
      await this.runPowerShell(`Stop-Process -Name ${this.psQuote(processName)} -Force -ErrorAction Stop`)
      return { ok: true, message: `Closed ${name}.` }
    } catch (err) {
      return { ok: false, message: `Couldn't close ${name}: ${(err as Error).message}` }
    }
  }

  async openUrl(url: string): Promise<ToolResult> {
    try {
      await this.runPowerShell(`Start-Process ${this.psQuote(url)}`)
      return { ok: true, message: `Opened ${url}.` }
    } catch (err) {
      return { ok: false, message: `Couldn't open that URL: ${(err as Error).message}` }
    }
  }

  /**
   * Core Audio (IAudioEndpointVolume) via inline C#, per the plan's risk
   * mitigation — no nircmd or other external binary. Untested on real
   * Windows; the COM interop signatures are correct as documented but
   * this is exactly the kind of thing that needs a real-PC pass.
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
    const script = `Add-Type -TypeDefinition "${WindowsPlatformControl.AUDIO_HELPER_CSHARP.replace(/"/g, '\\"')}"; ${action}`
    return this.runPowerShell(script)
  }

  async setVolume(percent: number): Promise<ToolResult> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent))) / 100
    try {
      await this.runAudioHelper(
        `$v = [AudioHelper]::GetVolumeObject(); $v.SetMasterVolumeLevelScalar(${clamped}, [Guid]::Empty)`
      )
      return { ok: true, message: `Volume set to ${Math.round(clamped * 100)} percent.` }
    } catch (err) {
      return { ok: false, message: `Couldn't set volume: ${(err as Error).message}` }
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
      return { ok: false, message: `Couldn't adjust volume: ${(err as Error).message}` }
    }
  }

  async setMute(muted: boolean): Promise<ToolResult> {
    try {
      await this.runAudioHelper(
        `$v = [AudioHelper]::GetVolumeObject(); $v.SetMute($${muted ? 'true' : 'false'}, [Guid]::Empty)`
      )
      return { ok: true, message: muted ? 'Muted.' : 'Unmuted.' }
    } catch (err) {
      return { ok: false, message: `Couldn't change mute state: ${(err as Error).message}` }
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
      return { ok: false, message: `Couldn't take a screenshot: ${(err as Error).message}` }
    }
  }

  async findApp(query: string): Promise<ToolResult> {
    const script = `Get-StartApps | Where-Object { $_.Name -like '*${query.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty Name`
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
      return { ok: false, message: `Couldn't search installed apps: ${(err as Error).message}` }
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
      return { ok: false, message: `Couldn't launch Steam: ${(err as Error).message}` }
    }
  }

  async focusWindow(appName: string): Promise<ToolResult> {
    try {
      await this.runPowerShell(
        `(New-Object -ComObject WScript.Shell).AppActivate(${this.psQuote(appName)}) | Out-Null`
      )
      return { ok: true, message: `Switched to ${appName}.` }
    } catch (err) {
      return { ok: false, message: `Couldn't switch to ${appName}: ${(err as Error).message}` }
    }
  }
}
