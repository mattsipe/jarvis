import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { setInteractive, toggleCommandCenter, showCommandCenter, showAmbient, broadcast } from './window'
import { toggleSession, isSessionActive, endSession, getCurrentSession } from './voice/sessionManager'
import { runAgentTurn } from './agent/loop'
import { resolveConfirmation, requestConfirmation } from './tools/confirmation'
import { getToolActivityHistory } from './tools/activity'
import { runToolStandalone } from './tools'
import { getBudgetStatus, setBudgetConfig, type BudgetConfig } from './usage'
import { presence } from './presence'
import { contextManager } from './context'
import { config, getConfigDiagnostics, saveApiKeys } from './config'
import { checkForUpdates, installUpdateAndRestart, getUpdateState } from './update/updater'

export { toggleSession } from './voice/sessionManager'

export function registerIpcHandlers(): void {
  ipcMain.on('hud:set-interactive', (_event, interactive: boolean) => {
    setInteractive(interactive)
  })

  // Ambient owns the real audio graph — relayed so Command Center's core can react to it too.
  ipcMain.on('hud:amplitude-relay', (_event, value: number | null) => {
    broadcast('hud:amplitude-relay', value)
  })

  ipcMain.on('voice:start', (_event, sampleRate: number) => {
    getCurrentSession()?.beginListening(sampleRate)
  })

  ipcMain.on('voice:audio-chunk', (_event, chunk: ArrayBuffer) => {
    getCurrentSession()?.pushAudio(Buffer.from(chunk))
  })

  // Renderer is the only one who knows when actual audio *playback*
  // (not just TTS generation) has finished — that's the correct moment
  // to resume listening for the next turn.
  ipcMain.on('voice:playback-finished', () => {
    getCurrentSession()?.resumeAfterPlayback()
  })

  // Latency telemetry's final mark — see voice/telemetry.ts.
  ipcMain.on('voice:playback-started', () => {
    getCurrentSession()?.notifyPlaybackStarted()
  })

  // Barge-in: renderer's local VAD detected the user talking while JARVIS
  // was thinking/speaking. `preroll` is the few hundred ms it buffered
  // while only monitoring, so the interruption's first words aren't lost.
  ipcMain.on(
    'voice:barge-in',
    (_event, payload: { sampleRate: number; preroll: ArrayBuffer[] }) => {
      getCurrentSession()?.bargeIn(
        payload.sampleRate,
        payload.preroll.map((buf) => Buffer.from(buf))
      )
    }
  )

  // Elevated-risk tool confirmation, resolved by a click in either HUD surface.
  ipcMain.on('tool:confirm-response', (_event, payload: { id: string; approved: boolean }) => {
    resolveConfirmation(payload.id, payload.approved)
  })

  // Command Center hotkey — dismisses it if already visible, otherwise shows it (and hides Ambient).
  ipcMain.on('command-center:toggle', () => {
    toggleCommandCenter()
  })

  // Explicit surface switches (Ambient and Command Center are mutually
  // exclusive presentations of the one app — see window.ts).
  ipcMain.on('surface:show-command-center', () => showCommandCenter())
  ipcMain.on('surface:show-ambient', () => showAmbient())

  // Same start/stop-conversation action as the global hotkey, triggerable from either HUD surface's UI.
  ipcMain.on('voice:toggle-session', () => {
    toggleSession()
  })

  // A renderer-side failure (e.g. getUserMedia rejecting) has no session
  // to report through — it re-broadcasts via the same 'voice:error'
  // channel main itself uses, so both HUD surfaces show it consistently.
  // A mic-stage failure also ends the session on main's side — otherwise
  // `sessionActive` stays stuck true with no way for audio to ever reach
  // it, and the next hotkey/button press would try to *end* a session
  // that never really started instead of starting a fresh one.
  ipcMain.on('voice:renderer-error', (_event, payload: { message: string; stage: string }) => {
    console.error(`[jarvis] renderer voice error (${payload.stage}):`, payload.message)
    broadcast('voice:error', payload)
    if (payload.stage === 'mic' && isSessionActive()) endSession()
  })

  // Update flow (see update/updater.ts) — 'check' is both the startup call
  // and the Command Center's "Check for Updates" button; 'install' only
  // ever fires from the user's explicit "Restart JARVIS?" confirmation.
  ipcMain.on('update:check', () => checkForUpdates())
  ipcMain.on('update:install', () => installUpdateAndRestart())
  ipcMain.handle('update:state', () => getUpdateState())

  // One-shot queries the Command Center makes on open, rather than
  // waiting for the next broadcast of each.
  ipcMain.handle('tool:activity-history', () => getToolActivityHistory())
  // Command Center's "Run Self-Test" button — exercises platform capabilities without requiring voice. See platform/windows.ts's selfTest().
  ipcMain.handle('system:self-test', () => runToolStandalone('self_test'))

  // Centralized API usage/budget manager — see usage/index.ts. One call
  // gets today's/this month's/all-time usage and cost per provider, the
  // configured limits, and whether either period's soft/hard limit has
  // been crossed; the setter is Command Center's Usage & Budget panel
  // editing the master protection switch or any limit.
  ipcMain.handle('usage:budget-status', () => getBudgetStatus())
  ipcMain.handle('usage:budget-set-config', (_event, patch: Partial<BudgetConfig>) => setBudgetConfig(patch))

  ipcMain.handle('context:live', () => contextManager.getLiveContext())
  ipcMain.handle('context:persistent', () => contextManager.getPersistent())
  // Boolean presence only — never the keys themselves — for the Integrations panel.
  ipcMain.handle('config:services-status', () => ({
    anthropic: Boolean(config.anthropicApiKey),
    elevenlabs: Boolean(config.elevenLabsApiKey),
    deepgram: Boolean(config.deepgramApiKey)
  }))

  // Full config-path diagnostics (dir/env-file/per-key presence — never
  // values) and the first-run/API-config UI's save action. See config.ts.
  ipcMain.handle('config:diagnostics', () => getConfigDiagnostics())
  ipcMain.handle(
    'config:save-keys',
    (_event, keys: { anthropic?: string; deepgram?: string; elevenlabs?: string }) => saveApiKeys(keys)
  )

  // Presence / hands-free (see main/presence/) — status for the Command
  // Center panel and tray, config toggles, the mute hotkey/button, and the
  // continuous stream of PCM chunks from the renderer's always-on
  // wake-word mic capture (audio/presenceCapture.ts) — completely separate
  // from voice:audio-chunk, which only ever carries audio during a real
  // Deepgram-bound conversation.
  ipcMain.handle('presence:status', () => presence.status())
  ipcMain.handle('presence:set-enabled', (_event, enabled: boolean) => {
    presence.setEnabled(enabled)
    return presence.status()
  })
  ipcMain.handle('presence:set-launch-at-login', (_event, launchAtLogin: boolean) => {
    presence.setLaunchAtLogin(launchAtLogin)
    return presence.status()
  })
  ipcMain.handle('presence:set-muted', (_event, muted: boolean) => {
    presence.setMuted(muted)
    return presence.status()
  })
  ipcMain.handle('presence:toggle-muted', () => {
    presence.toggleMuted()
    return presence.status()
  })
  // The wake-word engine needs no key/account, so this is only ever useful
  // for the rare "engine failed to load" case (e.g. a corrupted install) —
  // a manual retry from the Presence panel rather than requiring a restart.
  ipcMain.handle('presence:retry-engine', async () => {
    await presence.retryEngine()
    return presence.status()
  })
  ipcMain.on('presence:audio-chunk', (_event, chunk: ArrayBuffer) => {
    presence.ingestAudioChunk(chunk)
  })

  // Command Center's Memory panel — lists/edits/deletes what JARVIS
  // remembers (see context/memory.ts). Same records the remember/
  // recall_memory/update_memory/forget_memory tools use, so an edit made
  // here is visible to JARVIS on the very next turn.
  ipcMain.handle('memory:list', () => contextManager.memory.list())
  ipcMain.handle('memory:update', (_event, id: string, content: string) => contextManager.memory.update(id, { content }))
  ipcMain.handle('memory:delete', (_event, id: string) => contextManager.memory.remove(id))

  // Dev-only: lets automated/manual testing trigger the exact same code path
  // as the real hotkey, without needing OS Accessibility permission to
  // simulate a real keystroke. Never registered in a packaged build — the
  // hotkey remains the only trigger for real usage.
  if (is.dev) {
    ipcMain.on('voice:dev-toggle', () => toggleSession())

    // Exercises the agent/tool loop (including risk gating) with plain text,
    // bypassing STT/TTS entirely — useful for testing tool-calling without a
    // real mic. Never registered outside development.
    ipcMain.handle('dev:test-agent-turn', async (_event, text: string) => {
      const sentences: string[] = []
      const result = await runAgentTurn(text, (s) => sentences.push(s), undefined, {
        onToolStart: (call) => console.log('[jarvis][dev] tool start:', call.name, call.risk, call.input),
        onToolResult: (call, r) => console.log('[jarvis][dev] tool result:', call.name, r),
        // Uses the real confirmation gate (broadcasts tool:confirm-request,
        // resolvable by a real respondToolConfirmation call or a timeout) —
        // not an auto-approve stub — so this also exercises that path.
        requestConfirmation: (call) => requestConfirmation(call.name, `${call.name} ${JSON.stringify(call.input)}`)
      })
      return { ...result, sentences }
    })
  }
}
