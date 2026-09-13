import type { BrowserWindow } from 'electron'
import { createSttProvider, type SttProvider } from './stt'
import { ElevenLabsTts } from './tts/elevenlabs'
import { runAgentTurn } from '../agent/loop'

const INACTIVITY_TIMEOUT_MS = 8000

/**
 * One continuous conversation session — started by a single hotkey press,
 * ended by pressing it again (or by an inactivity timeout with no speech
 * at all). Within the session, each utterance auto-submits when Deepgram
 * detects a real pause (speechFinal), listening automatically resumes
 * once JARVIS's reply has actually finished *playing* (resumeAfterPlayback,
 * signaled by the renderer — only it knows real playback timing), and the
 * user can barge in while JARVIS is thinking/speaking (bargeIn) to cut it
 * off and start the next turn immediately, same session, same history.
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
  private utteranceFinished = false

  private turnId = 0
  private activeAbortController: AbortController | null = null
  private activeTts: ElevenLabsTts | null = null

  constructor(
    private win: BrowserWindow,
    private onEnded: () => void
  ) {}

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
      this.send('voice:error', { message: err.message, stage: 'stt' })
    })
    stt.start(sampleRate)
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
    this.ended = true
    this.turnId++
    this.clearInactivityTimer()
    this.stt?.stop()
    this.stt = null
    this.activeAbortController?.abort()
    this.activeAbortController = null
    this.activeTts?.close()
    this.activeTts = null
    this.send('hud:state', 'ambient')
    this.send('voice:session-ended', null)
    this.onEnded()
  }

  /** Called once the renderer confirms JARVIS's reply has fully finished playing. */
  resumeAfterPlayback(): void {
    if (this.ended) return
    this.send('voice:resume-listening', null)
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
    this.stt?.stop()
    this.stt = null
    const text = this.finalTranscript.trim()
    this.finalTranscript = ''

    if (!text) {
      // A pause was detected but nothing was actually said (e.g. the user
      // just cleared their throat) — stay in the session, go back to
      // listening rather than treating it as an empty turn.
      this.send('voice:resume-listening', null)
      return
    }

    const myTurnId = ++this.turnId
    this.respond(text, myTurnId).catch((err) => {
      if (myTurnId !== this.turnId) return // superseded by a barge-in or session end — ignore
      this.send('voice:error', {
        message: err instanceof Error ? err.message : String(err),
        stage: 'agent'
      })
      this.send('hud:state', 'error')
    })
  }

  private async respond(text: string, myTurnId: number): Promise<void> {
    this.send('hud:state', 'thinking')

    const controller = new AbortController()
    this.activeAbortController = controller

    const tts = new ElevenLabsTts()
    this.activeTts = tts
    let ttsStarted = false

    tts.on('audio', (chunk) => {
      if (myTurnId !== this.turnId) return
      if (!ttsStarted) {
        ttsStarted = true
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
    tts.connect()

    const result = await runAgentTurn(
      text,
      (sentence) => {
        if (myTurnId !== this.turnId) return // barged-in since — stop feeding TTS
        this.send('voice:assistant-text', sentence)
        tts.sendText(sentence)
      },
      controller.signal
    )

    if (myTurnId !== this.turnId) return // superseded while awaiting — don't signal end-of-turn
    tts.end()
    if (this.activeTts === tts) this.activeTts = null
    if (this.activeAbortController === controller) this.activeAbortController = null
    this.send('voice:agent-done', { tier: result.tier })
  }

  private send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }
}
