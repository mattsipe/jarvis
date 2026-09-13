import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { logInfo, logError } from '../logger'

export interface WindowInfo {
  hwnd: number
  title: string
  processName: string
  processId: number
  bounds: { x: number; y: number; width: number; height: number }
}

export interface ForegroundWindowInfo extends WindowInfo {
  cursor: { x: number; y: number }
}

export interface SteamGame {
  appId: string
  name: string
  installDir: string | null
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

const CALL_TIMEOUT_MS = 5000
const RESTART_BACKOFF_MS = 3000

/**
 * Typed client for jarvis-helper.exe — see native/jarvis-helper/Program.cs
 * for the protocol (line-delimited JSON-RPC over stdio) and for why it
 * exists at all (PowerShell's per-call startup/compile cost is fine for
 * rare calls, not for per-turn live context or audio control). Windows
 * only: on any other platform, every call rejects immediately and callers
 * fall back to their own platform-native path (see windows.ts, which is
 * the only real caller and always has a PowerShell fallback for exactly
 * this reason).
 *
 * Auto-restarts the process if it exits unexpectedly, with a fixed
 * backoff so a persistently-crashing helper doesn't spin. Every pending
 * call from before a crash is rejected immediately rather than left
 * hanging.
 */
class HelperClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private buffer = ''
  private starting = false
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  private resolveExePath(): string | null {
    const candidates = is.dev
      ? [join(app.getAppPath(), 'native', 'jarvis-helper', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'jarvis-helper.exe')]
      : [join(process.resourcesPath, 'jarvis-helper.exe')]
    return candidates.find((p) => existsSync(p)) ?? null
  }

  private ensureStarted(): boolean {
    if (process.platform !== 'win32') return false
    if (this.proc && !this.proc.killed) return true
    if (this.starting) return false

    const exePath = this.resolveExePath()
    if (!exePath) {
      logError('platform:helper', 'jarvis-helper.exe not found — falling back to per-call PowerShell for everything it would have handled.')
      return false
    }

    this.starting = true
    try {
      const proc = spawn(exePath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      this.proc = proc
      this.buffer = ''

      proc.stdout.setEncoding('utf-8')
      proc.stdout.on('data', (chunk: string) => this.onData(chunk))
      proc.stderr.setEncoding('utf-8')
      proc.stderr.on('data', (chunk: string) => logError('platform:helper', `stderr: ${chunk.trim()}`))

      proc.on('exit', (code) => {
        logError('platform:helper', `exited unexpectedly (code ${code}) — restarting in ${RESTART_BACKOFF_MS}ms`)
        this.proc = null
        this.failAllPending(new Error('jarvis-helper.exe exited'))
        this.scheduleRestart()
      })
      proc.on('error', (err) => {
        logError('platform:helper', `spawn failed: ${err.message}`)
        this.proc = null
      })

      logInfo('platform:helper', `started: ${exePath}`)
      return true
    } catch (err) {
      logError('platform:helper', `failed to start: ${(err as Error).message}`)
      return false
    } finally {
      this.starting = false
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.ensureStarted()
    }, RESTART_BACKOFF_MS)
  }

  private failAllPending(err: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timeout)
      call.reject(err)
    }
    this.pending.clear()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let parsed: { id: number; ok: boolean; result?: unknown; error?: string }
    try {
      parsed = JSON.parse(line)
    } catch {
      logError('platform:helper', `unparseable line: ${line.slice(0, 200)}`)
      return
    }
    const call = this.pending.get(parsed.id)
    if (!call) return
    this.pending.delete(parsed.id)
    clearTimeout(call.timeout)
    if (parsed.ok) call.resolve(parsed.result)
    else call.reject(new Error(parsed.error ?? 'jarvis-helper.exe reported an error with no message.'))
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.ensureStarted() || !this.proc) {
      return Promise.reject(new Error('jarvis-helper.exe is not running.'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`jarvis-helper.exe call "${method}" timed out after ${CALL_TIMEOUT_MS}ms.`))
      }, CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout })
      this.proc!.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  isRunning(): boolean {
    return this.proc !== null && !this.proc.killed
  }

  ping(): Promise<{ pong: true }> {
    return this.call('ping')
  }

  foregroundWindow(): Promise<ForegroundWindowInfo> {
    return this.call('foregroundWindow')
  }

  listWindows(): Promise<{ windows: WindowInfo[] }> {
    return this.call('listWindows')
  }

  focusWindow(hwnd: number): Promise<{ focused: boolean }> {
    return this.call('focusWindow', { hwnd })
  }

  audioGet(): Promise<{ volumePercent: number; muted: boolean }> {
    return this.call('audioGet')
  }

  audioSetVolume(percent: number): Promise<{ volumePercent: number }> {
    return this.call('audioSetVolume', { percent })
  }

  audioSetMute(muted: boolean): Promise<{ muted: boolean }> {
    return this.call('audioSetMute', { muted })
  }

  steamCatalog(): Promise<{ steamExePath: string | null; games: SteamGame[] }> {
    return this.call('steamCatalog')
  }

  /** Called once at app shutdown — best-effort, never blocks quitting. */
  stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.proc?.kill()
    this.proc = null
  }
}

export const jarvisHelper = new HelperClient()
