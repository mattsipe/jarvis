import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdir } from 'fs/promises'
import { app } from 'electron'
import { join } from 'path'
import os from 'os'
import { mintCanonicalId, type InstalledApplication, type LaunchOutcome } from '../apps/types'
import type { PlatformControl, SystemStatusInfo, ToolResult } from './types'

const execFileAsync = promisify(execFile)

/** Safely embeds a string as an AppleScript string literal. */
function osaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function osascript(script: string): Promise<string> {
  const { stdout } = await execFileAsync('osascript', ['-e', script])
  return stdout.trim()
}

async function listInstalledApps(): Promise<string[]> {
  const dirs = ['/Applications', join(os.homedir(), 'Applications')]
  const names: string[] = []
  for (const dir of dirs) {
    try {
      const entries = await readdir(dir)
      for (const entry of entries) {
        if (entry.endsWith('.app')) names.push(entry.replace(/\.app$/, ''))
      }
    } catch {
      // Directory may not exist — fine, just skip it.
    }
  }
  return names
}

/**
 * macOS adapter — used for development/testing since the primary machine
 * for this project is a Mac. Windows (windows.ts) is the authoritative
 * production adapter. Prefers structured commands (`open -a`, `osascript
 * activate`) over UI automation; nothing here needs the Accessibility
 * permission, which was never granted in this project.
 */
export class DarwinPlatformControl implements PlatformControl {
  readonly name = 'darwin' as const
  /** No UIA equivalent on macOS in this pass — see PlatformControl.operate's doc comment; tools/index.ts skips registering the Operate tools entirely when this is null. */
  readonly operate = null

  async closeApp(name: string): Promise<ToolResult> {
    try {
      await osascript(`quit app ${osaString(name)}`)
      return { ok: true, message: `Closed ${name}.` }
    } catch (err) {
      return { ok: false, message: `Couldn't close ${name}: ${(err as Error).message}` }
    }
  }

  async openUrl(url: string): Promise<ToolResult> {
    try {
      await execFileAsync('open', [url])
      return { ok: true, message: `Opened ${url}.` }
    } catch (err) {
      return { ok: false, message: `Couldn't open that URL: ${(err as Error).message}` }
    }
  }

  async setVolume(percent: number): Promise<ToolResult> {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    try {
      await osascript(`set volume output volume ${clamped}`)
      return { ok: true, message: `Volume set to ${clamped} percent.` }
    } catch (err) {
      return { ok: false, message: `Couldn't set volume: ${(err as Error).message}` }
    }
  }

  async adjustVolume(deltaPercent: number): Promise<ToolResult> {
    try {
      const current = parseInt(await osascript('output volume of (get volume settings)'), 10)
      return this.setVolume((Number.isFinite(current) ? current : 50) + deltaPercent)
    } catch (err) {
      return { ok: false, message: `Couldn't adjust volume: ${(err as Error).message}` }
    }
  }

  async setMute(muted: boolean): Promise<ToolResult> {
    try {
      await osascript(`set volume output muted ${muted}`)
      return { ok: true, message: muted ? 'Muted.' : 'Unmuted.' }
    } catch (err) {
      return { ok: false, message: `Couldn't change mute state: ${(err as Error).message}` }
    }
  }

  async getSystemStatus(): Promise<SystemStatusInfo> {
    let batteryPct: number | null = null
    try {
      const { stdout } = await execFileAsync('pmset', ['-g', 'batt'])
      const match = stdout.match(/(\d+)%/)
      if (match) batteryPct = parseInt(match[1], 10)
    } catch {
      batteryPct = null
    }
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    return {
      platform: 'macOS',
      hostname: os.hostname(),
      uptimeSec: os.uptime(),
      cpuLoad1m: os.loadavg()[0],
      memUsedPct: ((totalMem - freeMem) / totalMem) * 100,
      memTotalGB: totalMem / 1024 ** 3,
      batteryPct
    }
  }

  async screenshot(): Promise<ToolResult> {
    const filePath = join(app.getPath('pictures'), `jarvis-${Date.now()}.png`)
    try {
      await execFileAsync('screencapture', ['-x', filePath])
      return { ok: true, message: 'Screenshot captured.', data: { filePath } }
    } catch (err) {
      return { ok: false, message: `Couldn't take a screenshot: ${(err as Error).message}` }
    }
  }

  async findApp(query: string): Promise<ToolResult> {
    const apps = await listInstalledApps()
    const q = query.toLowerCase()
    const matches = apps.filter((a) => a.toLowerCase().includes(q))
    if (matches.length === 0) return { ok: false, message: `No installed app matches "${query}".` }
    return {
      ok: true,
      message: matches.length === 1 ? matches[0] : `Found: ${matches.slice(0, 8).join(', ')}.`,
      data: { matches }
    }
  }

  /** Dev-parity: canonicalId/appId === display name here since macOS launches by name via `open -a`. Always `desktop-path`-shaped — there's no AppsFolder-style activation distinct from a plain launch on this platform. */
  async listInstalledApps(): Promise<InstalledApplication[]> {
    const apps = await listInstalledApps()
    return apps.map((name) => ({
      canonicalId: mintCanonicalId(name),
      displayName: name,
      registrationSource: 'appsfolder' as const,
      launchKind: 'desktop-path' as const,
      appId: name
    }))
  }

  async launchInstalledApp(appEntry: InstalledApplication): Promise<LaunchOutcome> {
    try {
      await execFileAsync('open', ['-a', appEntry.appId])
      return { status: 'accepted', confidence: 'unverified' }
    } catch (err) {
      return { status: 'failed', error: (err as Error).message }
    }
  }

  async launchSteamGame(nameOrAppId: string): Promise<ToolResult> {
    const isNumeric = /^\d+$/.test(nameOrAppId.trim())
    try {
      if (isNumeric) {
        await execFileAsync('open', [`steam://rungameid/${nameOrAppId.trim()}`])
        return { ok: true, message: `Launching that game via Steam.` }
      }
      await execFileAsync('open', ['-a', 'Steam'])
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
      await osascript(`tell application ${osaString(appName)} to activate`)
      return { ok: true, message: `Switched to ${appName}.` }
    } catch (err) {
      return { ok: false, message: `Couldn't switch to ${appName}: ${(err as Error).message}` }
    }
  }

  /** Dev-parity counterpart to the Windows self-test — same interface, much smaller check list since this isn't the production adapter. */
  async selfTest(): Promise<ToolResult> {
    const checks: Array<{ name: string; ok: boolean; message: string }> = []
    try {
      await osascript('return 1')
      checks.push({ name: 'osascript-invocation', ok: true, message: 'ok' })
    } catch (err) {
      checks.push({ name: 'osascript-invocation', ok: false, message: (err as Error).message })
    }
    try {
      await execFileAsync('which', ['screencapture'])
      checks.push({ name: 'screencapture-binary', ok: true, message: 'found' })
    } catch (err) {
      checks.push({ name: 'screencapture-binary', ok: false, message: (err as Error).message })
    }
    const failed = checks.filter((c) => !c.ok)
    return {
      ok: failed.length === 0,
      message:
        failed.length === 0
          ? `All ${checks.length} macOS self-tests passed.`
          : `${failed.length} of ${checks.length} macOS self-tests failed.`,
      data: { checks }
    }
  }
}
