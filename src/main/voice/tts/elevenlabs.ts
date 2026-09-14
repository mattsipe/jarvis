import { EventEmitter } from 'events'
import { defaultSocketFactory, SOCKET_OPEN, type SocketFactory, type SocketLike } from '../transport/socket'
import type { TransportStatus } from '../transport/status'

export declare interface ElevenLabsTts {
  on(event: 'audio', listener: (chunk: Buffer) => void): this
  on(event: 'done', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: 'status', listener: (status: TransportStatus) => void): this
}

/**
 * Everything ElevenLabsTts needs from the outside world besides the
 * WebSocket itself, injected rather than imported directly — see
 * deepgram.ts's DeepgramDeps for the same pattern and why (fully
 * unit-testable with zero Electron/fs/config imports). See tts/index.ts
 * for the real wiring.
 */
export interface ElevenLabsDeps {
  apiKey: string
  voiceId: string
  logError: (scope: string, message: string) => void
}

/**
 * ElevenLabs Flash v2.5 streaming-input WebSocket TTS — ~75ms model
 * latency, the reason it's the plan's default (see the plan's Mandates).
 * Requests raw PCM16/16kHz output so the renderer can play it directly via
 * Web Audio with no MP3 decode step.
 *
 * Real-PC report: a TTS failure could leave a turn stuck rather than
 * killing the session outright — session.ts never terminates on a TTS
 * error, but 'done' previously only ever fired from a genuinely
 * successful stream, so an error mid-response meant the renderer's
 * playback-finished signal (voice:tts-done → notifyPlaybackFinished())
 * never arrived and the session never resumed listening for the next
 * turn. There's no useful reconnect-mid-response for TTS (whatever
 * already streamed can't be un-said, and ElevenLabs has no resume-from-
 * here API) — the fix is simpler: always emit 'done' after an error too,
 * so the turn degrades to text-only (the text was already sent to the
 * renderer before TTS ever started — see session.ts's respond()) and the
 * session moves on. The next turn's fresh ElevenLabsTts instance is a new
 * connection either way, so "recovers on subsequent turns" falls out of
 * the existing per-turn-instance design for free.
 */
export class ElevenLabsTts extends EventEmitter {
  private ws: SocketLike | null = null
  private ready = false
  private queue: string[] = []
  private doneEmitted = false
  private lastError: string | null = null

  constructor(
    private readonly deps: ElevenLabsDeps,
    private readonly socketFactory: SocketFactory = defaultSocketFactory
  ) {
    super()
  }

  connect(): void {
    this.emitStatus('connecting')
    const params = new URLSearchParams({
      model_id: 'eleven_flash_v2_5',
      output_format: 'pcm_16000'
    })
    const ws = this.socketFactory(`wss://api.elevenlabs.io/v1/text-to-speech/${this.deps.voiceId}/stream-input?${params.toString()}`, {
      'xi-api-key': this.deps.apiKey
    })
    this.ws = ws

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          generation_config: { chunk_length_schedule: [50, 90, 120, 150] }
        })
      )
      this.ready = true
      this.emitStatus('open')
      this.flushQueue()
    })

    ws.on('message', (data: unknown) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg.audio) {
          this.emit('audio', Buffer.from(msg.audio, 'base64'))
        }
        if (msg.isFinal) {
          this.emitDoneOnce()
        }
      } catch (err) {
        this.failAndFinish(err instanceof Error ? err.message : String(err))
      }
    })

    ws.on('error', (err: Error) => {
      this.deps.logError('elevenlabs', err.message)
      this.failAndFinish(err.message)
    })

    // Same gap as Deepgram's — a rejected handshake (bad key/quota) fires
    // 'unexpected-response', not 'error'. Previously this meant an auth
    // failure looked exactly like a normal, successful, silent reply.
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode
      const message =
        status === 401
          ? 'ElevenLabs rejected the connection — check ELEVENLABS_API_KEY.'
          : status === 429
            ? 'ElevenLabs rate limit or quota exceeded.'
            : `ElevenLabs connection failed (HTTP ${status}).`
      this.deps.logError('elevenlabs', `unexpected-response ${status}`)
      res.resume()
      this.failAndFinish(message)
    })

    ws.on('close', (code) => {
      // A close before ever opening successfully is a failure, not a
      // normal end-of-reply — otherwise it's silently treated as "done"
      // with zero audio ever having played.
      if (!this.ready && code !== 1000) {
        this.deps.logError('elevenlabs', `closed before ready, code ${code}`)
        this.failAndFinish(`ElevenLabs connection closed unexpectedly (code ${code}).`)
        return
      }
      this.emitStatus('closed')
      this.emitDoneOnce()
    })
  }

  /** Surfaces the error to the caller (session.ts shows it, but never tears down the session for a TTS failure) and always still unblocks the turn via 'done' — see the class doc comment. */
  private failAndFinish(message: string): void {
    this.lastError = message
    this.emitStatus('error')
    this.emit('error', new Error(message))
    this.emitDoneOnce()
  }

  private emitStatus(state: TransportStatus['state']): void {
    this.emit('status', {
      provider: 'elevenlabs',
      state,
      retryCount: 0,
      lastError: this.lastError,
      updatedAt: Date.now()
    } satisfies TransportStatus)
  }

  private emitDoneOnce(): void {
    if (this.doneEmitted) return
    this.doneEmitted = true
    this.emit('done')
  }

  /** Send a chunk of text (typically one sentence) to be spoken. */
  sendText(text: string): void {
    const payload = JSON.stringify({ text: `${text} ` })
    if (this.ready && this.ws?.readyState === SOCKET_OPEN) {
      this.ws.send(payload)
    } else {
      this.queue.push(payload)
    }
  }

  /** Signal that no more text is coming — flushes ElevenLabs' internal buffer. */
  end(): void {
    const payload = JSON.stringify({ text: '' })
    if (this.ready && this.ws?.readyState === SOCKET_OPEN) {
      this.ws.send(payload)
    } else {
      this.queue.push(payload)
    }
  }

  close(): void {
    this.ws?.close()
  }

  private flushQueue(): void {
    if (!this.ws) return
    for (const payload of this.queue) this.ws.send(payload)
    this.queue = []
  }
}
