import { ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { setInteractive, getOverlayWindow, toggleCommandCenter, broadcast } from './window'
import { VoiceSession } from './voice/session'
import { runAgentTurn } from './agent/loop'
import { resolveConfirmation, requestConfirmation } from './tools/confirmation'
import { getToolActivityHistory } from './tools/activity'
import { usage } from './voice/usage'
import { contextManager } from './context'
import { config } from './config'

let session: VoiceSession | null = null
let sessionActive = false

/**
 * Hotkey-driven session control: first press starts a continuous
 * conversation (see VoiceSession — auto-submits per utterance, listening
 * resumes automatically between turns), second press ends it immediately
 * regardless of which phase it's in. Called from main/index.ts's global
 * shortcut handler. The overlay window is only checked for existence —
 * events themselves are broadcast to every live surface (see
 * window.ts's broadcast()), not sent to a specific window.
 */
export function toggleSession(): void {
  const win = getOverlayWindow()
  if (!win) return

  if (!sessionActive) {
    sessionActive = true
    session = new VoiceSession(() => {
      sessionActive = false
      session = null
    })
    broadcast('voice:toggle', { listening: true })
  } else {
    session?.endSession()
    sessionActive = false
    session = null
    broadcast('voice:toggle', { listening: false })
  }
}

export function registerIpcHandlers(): void {
  ipcMain.on('hud:set-interactive', (_event, interactive: boolean) => {
    setInteractive(interactive)
  })

  // Ambient owns the real audio graph — relayed so Command Center's core can react to it too.
  ipcMain.on('hud:amplitude-relay', (_event, value: number | null) => {
    broadcast('hud:amplitude-relay', value)
  })

  ipcMain.on('voice:start', (_event, sampleRate: number) => {
    session?.beginListening(sampleRate)
  })

  ipcMain.on('voice:audio-chunk', (_event, chunk: ArrayBuffer) => {
    session?.pushAudio(Buffer.from(chunk))
  })

  // Renderer is the only one who knows when actual audio *playback*
  // (not just TTS generation) has finished — that's the correct moment
  // to resume listening for the next turn.
  ipcMain.on('voice:playback-finished', () => {
    session?.resumeAfterPlayback()
  })

  // Latency telemetry's final mark — see voice/telemetry.ts.
  ipcMain.on('voice:playback-started', () => {
    session?.notifyPlaybackStarted()
  })

  // Barge-in: renderer's local VAD detected the user talking while JARVIS
  // was thinking/speaking. `preroll` is the few hundred ms it buffered
  // while only monitoring, so the interruption's first words aren't lost.
  ipcMain.on(
    'voice:barge-in',
    (_event, payload: { sampleRate: number; preroll: ArrayBuffer[] }) => {
      session?.bargeIn(
        payload.sampleRate,
        payload.preroll.map((buf) => Buffer.from(buf))
      )
    }
  )

  // Elevated-risk tool confirmation, resolved by a click in either HUD surface.
  ipcMain.on('tool:confirm-response', (_event, payload: { id: string; approved: boolean }) => {
    resolveConfirmation(payload.id, payload.approved)
  })

  // Command Center — opened/closed from Ambient's launcher control or the global hotkey.
  ipcMain.on('command-center:toggle', () => {
    toggleCommandCenter()
  })

  // Same start/stop-conversation action as the global hotkey, triggerable from either HUD surface's UI.
  ipcMain.on('voice:toggle-session', () => {
    toggleSession()
  })

  // One-shot queries the Command Center makes on open, rather than
  // waiting for the next broadcast of each.
  ipcMain.handle('tool:activity-history', () => getToolActivityHistory())
  ipcMain.handle('usage:snapshot', () => usage.snapshot())
  ipcMain.handle('context:live', () => contextManager.getLiveContext())
  ipcMain.handle('context:persistent', () => contextManager.getPersistent())
  // Presence only — never the keys themselves — for the Integrations panel.
  ipcMain.handle('config:services-status', () => ({
    anthropic: Boolean(config.anthropicApiKey),
    elevenlabs: Boolean(config.elevenLabsApiKey),
    deepgram: Boolean(config.deepgramApiKey)
  }))

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
