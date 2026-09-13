import type { BrowserWindow } from 'electron'
import { createSttProvider, type SttProvider } from './stt'
import { ElevenLabsTts } from './tts/elevenlabs'
import { runAgentTurn } from '../agent/loop'

/**
 * One hotkey toggle cycle: opens STT, accumulates the final transcript,
 * then — once the user stops listening — runs the Claude turn and speaks
 * the reply, forwarding every stage as an IPC event so the HUD can react
 * (listening -> thinking -> speaking -> success/error). This is the
 * critical vertical slice's voice half; see the plan's Milestones.
 */
export class VoiceSession {
  private stt: SttProvider | null = null
  private finalTranscript = ''

  constructor(private win: BrowserWindow) {}

  startListening(sampleRate: number): void {
    this.finalTranscript = ''
    const stt = createSttProvider()
    stt.on('transcript', (e) => {
      if (e.isFinal) {
        this.finalTranscript = `${this.finalTranscript} ${e.text}`.trim()
      }
      this.send('voice:transcript', { text: e.text, isFinal: e.isFinal })
    })
    stt.on('error', (err) => this.send('voice:error', { message: err.message, stage: 'stt' }))
    stt.start(sampleRate)
    this.stt = stt
  }

  pushAudio(chunk: Buffer): void {
    this.stt?.sendAudio(chunk)
  }

  /** Stops STT and, if anything was said, runs the agent turn and speaks the reply. */
  async stopAndRespond(): Promise<void> {
    this.stt?.stop()
    this.stt = null
    const text = this.finalTranscript.trim()

    if (!text) {
      this.send('hud:state', 'ambient')
      return
    }

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

    try {
      const result = await runAgentTurn(text, (sentence) => {
        this.send('voice:assistant-text', sentence)
        tts.sendText(sentence)
      })
      tts.end()
      this.send('voice:agent-done', { tier: result.tier })
    } catch (err) {
      this.send('voice:error', {
        message: err instanceof Error ? err.message : String(err),
        stage: 'agent'
      })
      this.send('hud:state', 'error')
      tts.close()
    }
  }

  private send(channel: string, payload: unknown): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload)
  }
}
