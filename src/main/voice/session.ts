import type { BrowserWindow } from 'electron'
import { createSttProvider, type SttProvider } from './stt'
import { ElevenLabsTts } from './tts/elevenlabs'
import { runAgentTurn } from '../agent/loop'

const INACTIVITY_TIMEOUT_MS = 8000

/**
 * One continuous conversation session — started by a single hotkey press,
 * ended by pressing it again (or by an inactivity timeout with no speech
 * at all). Within the session, each utterance auto-submits when Deepgram
 * detects a real pause (speechFinal), and listening automatically resumes
 * once JARVIS's reply has fully finished *playing* — signaled by the
 * renderer via resumeAfterPlayback(), since only it knows real playback
 * timing. No repeated hotkey presses per turn; the hotkey is now purely
 * the session start/end control (see Weston's M2 follow-up).
 */
export class VoiceSession {
  private stt: SttProvider | null = null
  private finalTranscript = ''
  private ended = false
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null
  /** Guards against a stale speechFinal arriving during the old STT
   *  connection's close-grace-period (see DeepgramStt.stop()) from
   *  triggering finishUtterance() a second time for the same phase. */
  private utteranceFinished = false

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

  /** Hotkey pressed again — ends the session immediately, whatever phase it's in. */
  endSession(): void {
    if (this.ended) return
    this.ended = true
    this.clearInactivityTimer()
    this.stt?.stop()
    this.stt = null
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

    this.respond(text).catch((err) => {
      this.send('voice:error', {
        message: err instanceof Error ? err.message : String(err),
        stage: 'agent'
      })
      this.send('hud:state', 'error')
    })
  }

  private async respond(text: string): Promise<void> {
    this.send('hud:state', 'thinking')

    const tts = new ElevenLabsTts()
    let ttsStarted = false

    tts.on('audio', (chunk) => {
      if (!ttsStarted) {
        ttsStarted = true
        this.send('hud:state', 'speaking')
      }
      const arrayBuffer = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
      this.send('voice:tts-audio-chunk', arrayBuffer)
    })
    tts.on('done', () => this.send('voice:tts-done', null))
    tts.on('error', (err) => this.send('voice:error', { message: err.message, stage: 'tts' }))
    tts.connect()

    const result = await runAgentTurn(text, (sentence) => {
      this.send('voice:assistant-text', sentence)
      tts.sendText(sentence)
    })
    tts.end()
    this.send('voice:agent-done', { tier: result.tier })
  }

  private send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }
}
