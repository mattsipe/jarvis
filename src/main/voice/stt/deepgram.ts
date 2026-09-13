import WebSocket from 'ws'
import { config } from '../../config'
import { SttProvider } from './types'

/**
 * Deepgram real-time streaming STT over WebSocket. ~300ms time-to-first-word
 * per Deepgram's published streaming latency — the reason it's the default
 * provider (see the plan's Mandates).
 */
export class DeepgramStt extends SttProvider {
  private ws: WebSocket | null = null
  private closing = false

  start(sampleRate: number): void {
    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      encoding: 'linear16',
      sample_rate: String(sampleRate),
      channels: '1'
    })
    this.closing = false
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: { Authorization: `Token ${config.deepgramApiKey}` }
    })

    this.ws.on('open', () => {
      // no-op — ready to receive audio
    })

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type !== 'Results') return
        const alt = msg.channel?.alternatives?.[0]
        const text: string = alt?.transcript ?? ''
        const speechFinal = Boolean(msg.speech_final)
        // Emit even with empty text when speechFinal fires (e.g. a trailing
        // silence-only segment) — the caller needs that "utterance ended"
        // signal regardless of whether it carried new words.
        if (!text && !speechFinal) return
        this.emit('transcript', { text, isFinal: Boolean(msg.is_final), speechFinal })
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
      }
    })

    this.ws.on('error', (err: Error) => {
      this.emit('error', err)
    })

    this.ws.on('close', () => {
      this.emit('closed')
    })
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    }
  }

  stop(): void {
    if (this.closing || !this.ws) return
    this.closing = true
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      // Give Deepgram a moment to flush the final transcript before we close.
      setTimeout(() => this.ws?.close(), 400)
    } else {
      this.ws.close()
    }
  }
}
