import { EventEmitter } from 'events'
import WebSocket from 'ws'
import { config } from '../../config'

export declare interface ElevenLabsTts {
  on(event: 'audio', listener: (chunk: Buffer) => void): this
  on(event: 'done', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
}

/**
 * ElevenLabs Flash v2.5 streaming-input WebSocket TTS — ~75ms model
 * latency, the reason it's the plan's default (see the plan's Mandates).
 * Requests raw PCM16/16kHz output so the renderer can play it directly via
 * Web Audio with no MP3 decode step.
 */
export class ElevenLabsTts extends EventEmitter {
  private ws: WebSocket | null = null
  private ready = false
  private queue: string[] = []
  private doneEmitted = false

  connect(): void {
    const params = new URLSearchParams({
      model_id: 'eleven_flash_v2_5',
      output_format: 'pcm_16000'
    })
    this.ws = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${config.elevenLabsVoiceId}/stream-input?${params.toString()}`,
      { headers: { 'xi-api-key': config.elevenLabsApiKey } }
    )

    this.ws.on('open', () => {
      this.ws?.send(
        JSON.stringify({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          generation_config: { chunk_length_schedule: [50, 90, 120, 150] }
        })
      )
      this.ready = true
      this.flushQueue()
    })

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.audio) {
          this.emit('audio', Buffer.from(msg.audio, 'base64'))
        }
        if (msg.isFinal) {
          this.emitDoneOnce()
        }
      } catch (err) {
        this.emit('error', err instanceof Error ? err : new Error(String(err)))
      }
    })

    this.ws.on('error', (err: Error) => this.emit('error', err))
    this.ws.on('close', () => this.emitDoneOnce())
  }

  private emitDoneOnce(): void {
    if (this.doneEmitted) return
    this.doneEmitted = true
    this.emit('done')
  }

  /** Send a chunk of text (typically one sentence) to be spoken. */
  sendText(text: string): void {
    const payload = JSON.stringify({ text: `${text} ` })
    if (this.ready) {
      this.ws?.send(payload)
    } else {
      this.queue.push(payload)
    }
  }

  /** Signal that no more text is coming — flushes ElevenLabs' internal buffer. */
  end(): void {
    const payload = JSON.stringify({ text: '' })
    if (this.ready) {
      this.ws?.send(payload)
    } else {
      this.queue.push(payload)
    }
  }

  close(): void {
    this.ws?.close()
  }

  private flushQueue(): void {
    for (const payload of this.queue) this.ws?.send(payload)
    this.queue = []
  }
}
