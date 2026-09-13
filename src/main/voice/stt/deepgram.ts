import WebSocket from 'ws'
import type { IncomingMessage } from 'http'
import { config } from '../../config'
import { SttProvider } from './types'
import { logError } from '../../logger'

/**
 * Deepgram real-time streaming STT over WebSocket. ~300ms time-to-first-word
 * per Deepgram's published streaming latency — the reason it's the default
 * provider (see the plan's Mandates).
 */
export class DeepgramStt extends SttProvider {
  private ws: WebSocket | null = null
  private closing = false
  private ready = false
  private queue: Buffer[] = []

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
    this.ready = false
    this.queue = []
    this.ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: { Authorization: `Token ${config.deepgramApiKey}` }
    })

    this.ws.on('open', () => {
      this.ready = true
      // Flush anything captured while the handshake was still in flight —
      // otherwise the first ~100-300ms of the utterance (or a barge-in's
      // pre-roll buffer, see MicCapture) is silently dropped.
      for (const chunk of this.queue) this.ws?.send(chunk)
      this.queue = []
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
      logError('deepgram', err.message)
      this.emit('error', err)
    })

    // `ws` emits 'unexpected-response' (not 'error') when the server
    // rejects the handshake itself — e.g. a 401 for a missing/bad API key.
    // Without this handler that failure mode was silent: no 'error' event
    // fired, sendAudio() would just queue forever, and the user would
    // appear stuck in "listening" with no explanation.
    this.ws.on('unexpected-response', (_req, res: IncomingMessage) => {
      const status = res.statusCode
      const message =
        status === 401 || status === 403
          ? 'Deepgram rejected the connection — check DEEPGRAM_API_KEY.'
          : `Deepgram connection failed (HTTP ${status}).`
      logError('deepgram', `unexpected-response ${status}`)
      this.emit('error', new Error(message))
      res.resume() // drain so the socket can close cleanly
    })

    this.ws.on('close', (code) => {
      if (code !== 1000 && code !== 1005) logError('deepgram', `closed with code ${code}`)
      this.emit('closed')
    })
  }

  private static readonly MAX_QUEUED_CHUNKS = 50 // ~4s of audio at 80ms/chunk — a connection that never opens shouldn't leak memory

  sendAudio(chunk: Buffer): void {
    if (this.closing) return
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(chunk)
    } else {
      this.queue.push(chunk)
      if (this.queue.length > DeepgramStt.MAX_QUEUED_CHUNKS) this.queue.shift()
    }
  }

  stop(): void {
    if (this.closing || !this.ws) return
    this.closing = true
    this.queue = []
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      // Give Deepgram a moment to flush the final transcript before we close.
      setTimeout(() => this.ws?.close(), 400)
    } else {
      this.ws.close()
    }
  }
}
