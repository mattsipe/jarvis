import { createSttProvider, type SttProvider } from './stt'
import { ElevenLabsTts } from './tts/elevenlabs'
import { runAgentTurn, type ToolCallInfo } from '../agent/loop'
import { broadcast } from '../window'
import { TurnTimer } from './telemetry'
import { usage } from './usage'
import { config } from '../config'
import { requestConfirmation, tryResolveConfirmationFromSpeech } from '../tools/confirmation'
import { recordToolActivity } from '../tools/activity'
import { contextManager } from '../context'

const INACTIVITY_TIMEOUT_MS = 8000
// Hard cap on one continuous session, regardless of activity — bounds
// worst-case Deepgram streaming minutes if a session is somehow never
// ended normally (e.g. the app is left running and the hotkey forgotten).
const MAX_SESSION_MS = config.maxSessionMinutes * 60 * 1000

function describeToolCall(call: ToolCallInfo): string {
  const input = call.input && typeof call.input === 'object' ? JSON.stringify(call.input) : String(call.input ?? '')
  return `${call.name}${input && input !== '{}' ? ` ${input}` : ''}`
}

/**
 * One continuous conversation session — started by a single hotkey press,
 * ended by pressing it again (or by an inactivity/max-duration timeout).
 * Within the session, each utterance auto-submits when Deepgram detects a
 * real pause (speechFinal), listening automatically resumes once JARVIS's
 * reply has actually finished *playing* (resumeAfterPlayback, signaled by
 * the renderer — only it knows real playback timing), and the user can
 * barge in while JARVIS is thinking/speaking (bargeIn) to cut it off and
 * start the next turn immediately, same session, same history.
 *
 * Also doubles as the capture path for a spoken yes/no when an elevated
 * tool call is awaiting confirmation (see requestToolConfirmation) — it
 * briefly re-enters a listening phase for just that reply, distinct from
 * a normal conversational turn (finishUtterance branches on
 * `awaitingConfirmationSpeech`).
 *
 * `turnId` versions every response so a stale Claude/TTS event from a
 * turn that's since been superseded (by a barge-in, or the session
 * ending) can never surface — see the guards in respond().
 */
export class VoiceSession {
  private stt: SttProvider | null = null
  private finalTranscript = ''
  private ended = false
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  private maxSessionTimer: ReturnType<typeof setTimeout> | null = null
  private utteranceFinished = false
  private awaitingConfirmationSpeech = false
  private currentTurnTimer: TurnTimer | null = null
  private ttsCharWarningLogged = false

  private turnId = 0
  private activeAbortController: AbortController | null = null
  private activeTts: ElevenLabsTts | null = null

  constructor(private onEnded: () => void) {
    usage.recordSessionStart()
    contextManager.setVoiceSessionActive(true)
    this.maxSessionTimer = setTimeout(() => this.endSession(), MAX_SESSION_MS)
  }

  /** Starts (or restarts, for the next turn) one listening phase. */
  beginListening(sampleRate: number): void {
    if (this.ended) return
    this.finalTranscript = ''
    this.utteranceFinished = false
    const stt = createSttProvider()
    stt.on('transcript', (e) => {
      if (this.utteranceFinished) return
      this.resetInactivityTimer()
      if (e.isFinal && e.text) {
        this.finalTranscript = `${this.finalTranscript} ${e.text}`.trim()
      }
      if (e.text) this.send('voice:transcript', { text: e.text, isFinal: e.isFinal })
      if (e.speechFinal) this.finishUtterance()
    })
    stt.on('error', (err) => {
      if (this.utteranceFinished) return
      // An STT-connection failure (bad key, network/firewall block, etc.)
      // is unrecoverable for this session — previously this only sent the
      // error and left the session dangling (mic still open, nothing ever
      // transcribing again). End it cleanly instead so the next
      // hotkey/button press starts fresh rather than trying to *end* a
      // session that never really worked. hud:state stays on 'error'
      // (its own auto-revert timer returns to ambient — see hudStore.ts)
      // instead of endSession()'s usual immediate 'ambient' broadcast,
      // so the error is actually visible for a moment.
      this.utteranceFinished = true
      this.send('voice:error', { message: err.message, stage: 'stt' })
      this.send('hud:state', 'error')
      this.terminate()
    })
    stt.start(sampleRate)
    usage.startSttStream()
    this.stt = stt
    this.resetInactivityTimer()
  }

  pushAudio(chunk: Buffer): void {
    this.stt?.sendAudio(chunk)
  }

  /**
   * User started talking while JARVIS was thinking/speaking. Invalidates
   * the in-flight response (Claude + TTS both cancelled, nothing further
   * from it can reach the renderer — see the turnId guards in respond()),
   * then immediately opens a fresh listening phase, same session/history.
   * `preroll` is the few hundred ms of audio MicCapture buffered locally
   * while it was only monitoring for barge-in, so the user's first words
   * aren't clipped — sent right after the new STT connection opens
   * (DeepgramStt queues audio until then, so ordering is preserved).
   */
  bargeIn(sampleRate: number, preroll: Buffer[]): void {
    if (this.ended) return
    this.turnId++
    this.activeAbortController?.abort()
    this.activeAbortController = null
    this.activeTts?.close()
    this.activeTts = null
    this.beginListening(sampleRate)
    for (const chunk of preroll) this.pushAudio(chunk)
  }

  /** Hotkey pressed again — ends the session immediately, whatever phase it's in. */
  endSession(): void {
    if (this.ended) return
    this.terminate()
    this.send('hud:state', 'ambient')
  }

  /** Shared teardown for both a normal end and an unrecoverable error — see stt.on('error') above. */
  private terminate(): void {
    if (this.ended) return
    this.ended = true
    this.turnId++
    this.clearInactivityTimer()
    if (this.maxSessionTimer) clearTimeout(this.maxSessionTimer)
    this.stopStt()
    this.activeAbortController?.abort()
    this.activeAbortController = null
    this.activeTts?.close()
    this.activeTts = null
    contextManager.setVoiceSessionActive(false)
    this.send('voice:session-ended', null)
    this.onEnded()
  }

  /** Called once the renderer confirms JARVIS's reply has fully finished playing. */
  resumeAfterPlayback(): void {
    if (this.ended) return
    this.send('voice:resume-listening', null)
  }

  /** Called from IPC once the renderer schedules the first audio sample of a reply — the true playback-start latency mark. */
  notifyPlaybackStarted(): void {
    if (!this.currentTurnTimer) return
    this.currentTurnTimer.mark('playbackStart')
    this.currentTurnTimer.report()
    this.send('voice:latency', this.currentTurnTimer.snapshot()) // Command Center diagnostics panel
  }

  private stopStt(): void {
    if (this.stt) {
      this.stt.stop()
      this.stt = null
      usage.stopSttStream()
    }
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer()
    this.inactivityTimer = setTimeout(() => {
      if (!this.finalTranscript.trim()) this.endSession()
    }, INACTIVITY_TIMEOUT_MS)
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
      this.inactivityTimer = null
    }
  }

  private finishUtterance(): void {
    if (this.utteranceFinished) return
    this.utteranceFinished = true
    this.clearInactivityTimer()
    this.stopStt()
    const text = this.finalTranscript.trim()
    this.finalTranscript = ''

    // Not a new conversational turn — this listening phase was opened
    // just to capture a yes/no for a pending elevated-tool confirmation.
    // requestToolConfirmation's `finally` handles returning to a normal
    // state once the confirmation resolves (by voice, click, or timeout).
    if (this.awaitingConfirmationSpeech) {
      if (text) tryResolveConfirmationFromSpeech(text)
      else this.send('voice:resume-listening', null) // pause with nothing said — keep waiting
      return
    }

    if (!text) {
      // A pause was detected but nothing was actually said (e.g. the user
      // just cleared their throat) — stay in the session, go back to
      // listening rather than treating it as an empty turn.
      this.send('voice:resume-listening', null)
      return
    }

    const timer = new TurnTimer()
    timer.mark('speechEnd')
    timer.mark('sttFinal')
    this.currentTurnTimer = timer

    const myTurnId = ++this.turnId
    this.respond(text, myTurnId, timer).catch((err) => {
      if (myTurnId !== this.turnId) return // superseded by a barge-in or session end — ignore
      this.send('voice:error', {
        message: err instanceof Error ? err.message : String(err),
        stage: 'agent'
      })
      this.send('hud:state', 'error')
    })
  }

  /**
   * Wraps tools/confirmation.ts's promise with a dedicated listening phase
   * so a spoken "yes"/"no" can resolve it without another hotkey press —
   * see finishUtterance's awaitingConfirmationSpeech branch.
   */
  private async requestToolConfirmation(call: ToolCallInfo): Promise<boolean> {
    this.awaitingConfirmationSpeech = true
    this.send('voice:resume-listening', null) // renderer re-opens streaming + Deepgram picks up the reply
    try {
      return await requestConfirmation(call.name, describeToolCall(call))
    } finally {
      this.awaitingConfirmationSpeech = false
      this.stopStt()
      if (!this.ended) this.send('hud:state', 'thinking') // back to a working state while the agent loop continues
    }
  }

  private async respond(text: string, myTurnId: number, timer: TurnTimer): Promise<void> {
    this.send('hud:state', 'thinking')

    const controller = new AbortController()
    this.activeAbortController = controller

    const tts = new ElevenLabsTts()
    this.activeTts = tts
    let ttsStarted = false
    let firstSentenceSeen = false

    tts.on('audio', (chunk) => {
      if (myTurnId !== this.turnId) return
      if (!ttsStarted) {
        ttsStarted = true
        timer.mark('firstTtsAudio')
        this.send('hud:state', 'speaking')
      }
      const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      this.send('voice:tts-audio-chunk', arrayBuffer)
    })
    tts.on('done', () => {
      if (myTurnId !== this.turnId) return
      this.send('voice:tts-done', null)
    })
    tts.on('error', (err) => {
      if (myTurnId !== this.turnId) return
      this.send('voice:error', { message: err.message, stage: 'tts' })
    })

    timer.mark('ttsRequest')
    tts.connect() // opened in parallel with the Claude call below, not lazily on first sentence — avoids adding the WS handshake to perceived latency

    const result = await runAgentTurn(
      text,
      (sentence) => {
        if (myTurnId !== this.turnId) return // barged-in since — stop feeding TTS
        if (!firstSentenceSeen) {
          firstSentenceSeen = true
          timer.mark('firstSpeakablePhrase')
        }
        this.send('voice:assistant-text', sentence)

        const withinCap = !config.ttsDevCharCap || usage.snapshot().ttsCharsTotal < config.ttsDevCharCap
        if (withinCap) {
          usage.addTtsChars(sentence.length)
          tts.sendText(sentence)
        } else if (!this.ttsCharWarningLogged) {
          this.ttsCharWarningLogged = true
          console.warn(
            `[jarvis] TTS_DEV_CHAR_CAP (${config.ttsDevCharCap}) reached — further sentences this turn are shown but not spoken.`
          )
        }
      },
      controller.signal,
      {
        onFirstToken: () => timer.mark('claudeFirstToken'),
        onToolStart: (call) => {
          recordToolActivity({
            id: call.id,
            name: call.name,
            risk: call.risk,
            input: call.input,
            status: call.risk === 'elevated' ? 'confirm-pending' : 'started',
            timestamp: new Date().toISOString()
          })
          if (call.risk !== 'elevated' && myTurnId === this.turnId) this.send('hud:state', 'acting')
        },
        onToolResult: (call, toolResult) => {
          recordToolActivity({
            id: call.id,
            name: call.name,
            risk: call.risk,
            input: call.input,
            status: toolResult.ok ? 'success' : call.risk === 'elevated' && !toolResult.ok ? 'denied' : 'error',
            message: toolResult.message,
            timestamp: new Date().toISOString(),
            diagnostics: toolResult.diagnostics
          })
        },
        requestConfirmation: (call) => this.requestToolConfirmation(call)
      }
    )

    if (myTurnId !== this.turnId) return // superseded while awaiting — don't signal end-of-turn
    tts.end()
    if (this.activeTts === tts) this.activeTts = null
    if (this.activeAbortController === controller) this.activeAbortController = null
    this.send('voice:agent-done', { tier: result.tier })
  }

  private send(channel: string, payload: unknown): void {
    broadcast(channel, payload)
  }
}
