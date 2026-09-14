import { SttProvider } from './types'
import { backoffDelayMs } from '../transport/backoff'
import { defaultSocketFactory, SOCKET_OPEN, type SocketFactory, type SocketLike } from '../transport/socket'
import type { TransportStatus } from '../transport/status'

const MAX_RECONNECT_ATTEMPTS = 3
const KEEPALIVE_INTERVAL_MS = 5000

/**
 * Everything DeepgramStt needs from the outside world that isn't the
 * WebSocket itself, injected rather than imported directly — this class
 * (unlike most of the rest of main/) has zero Electron/fs/network-config
 * imports, deliberately, so its reconnect state machine is fully
 * unit-testable the same way the codebase's other "pure core" modules are
 * (see wakewordMath.ts, budgetLogic.ts). See stt/index.ts for the real
 * wiring (config.deepgramApiKey, budgetManager, logger).
 */
export interface DeepgramDeps {
  apiKey: string
  checkBudget: () => { allowed: boolean; reason?: string }
  logInfo: (scope: string, message: string) => void
  logError: (scope: string, message: string) => void
}

/**
 * Real-PC report: a random WebSocket error mid-conversation was killing
 * the whole session outright — session.ts treated any 'error' from this
 * class as unrecoverable. Most of what actually reaches a WebSocket
 * 'error'/unexpected 'close' mid-stream is transient (a brief network
 * blip, a server-side hiccup) and Deepgram's own idle-timeout can also
 * close a perfectly healthy connection during a long pause if nothing at
 * all — not even a keepalive — is sent for a while.
 *
 * This class now reconnects itself, in place, up to MAX_RECONNECT_ATTEMPTS
 * times with jittered exponential backoff (see transport/backoff.ts)
 * before ever emitting the public 'error' event session.ts treats as
 * fatal — session.ts's transcript/error listeners never need to know a
 * reconnect happened at all in the common case. An auth failure
 * (401/403) is never retried; the API key won't become valid by waiting.
 * A `generation` counter guards every socket event handler so a late
 * event from an abandoned/replaced socket (e.g. one still closing when a
 * reconnect's new socket has already opened) can never be mistaken for
 * one from the current connection — the same guard shape as the
 * `turnId`/`myTurnId` pattern already used in voice/session.ts.
 */
export class DeepgramStt extends SttProvider {
  private ws: SocketLike | null = null
  private closing = false
  private ready = false
  private queue: Buffer[] = []
  private sampleRate = 16000
  private generation = 0
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private lastError: string | null = null

  constructor(
    private readonly deps: DeepgramDeps,
    private readonly socketFactory: SocketFactory = defaultSocketFactory
  ) {
    super()
  }

  start(sampleRate: number): void {
    this.sampleRate = sampleRate
    this.closing = false
    this.reconnectAttempts = 0
    this.queue = []
    this.connect()
  }

  private connect(): void {
    const generation = ++this.generation
    this.ready = false
    this.emitStatus(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting')

    const params = new URLSearchParams({
      model: 'nova-3',
      language: 'en',
      punctuate: 'true',
      smart_format: 'true',
      interim_results: 'true',
      endpointing: '300',
      encoding: 'linear16',
      sample_rate: String(this.sampleRate),
      channels: '1'
    })
    const ws = this.socketFactory(`wss://api.deepgram.com/v1/listen?${params.toString()}`, { Authorization: `Token ${this.deps.apiKey}` })
    this.ws = ws

    ws.on('open', () => {
      if (generation !== this.generation) return
      this.ready = true
      this.reconnectAttempts = 0
      this.lastError = null
      this.emitStatus('open')
      this.startKeepalive()
      // Flush anything captured while the handshake (or a reconnect) was
      // still in flight — otherwise the first ~100-300ms of the utterance
      // (or a barge-in's pre-roll buffer, see MicCapture) is silently
      // dropped.
      for (const chunk of this.queue) ws.send(chunk)
      this.queue = []
    })

    ws.on('message', (data: unknown) => {
      if (generation !== this.generation) return
      try {
        const msg = JSON.parse(String(data))
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

    ws.on('error', (err: Error) => {
      if (generation !== this.generation) return
      // Deliberately does not decide reconnect-vs-fatal here — 'close'
      // fires right after this for every real failure and is the single
      // place that decides, so the logic isn't duplicated/racing across
      // two handlers.
      this.lastError = err.message
      this.deps.logError('deepgram', err.message)
    })

    // `ws` emits 'unexpected-response' (not 'error') when the server
    // rejects the handshake itself — e.g. a 401 for a missing/bad API key.
    // Unlike a mid-stream drop, retrying this can never succeed, so it's
    // treated as fatal immediately rather than burning the retry budget.
    ws.on('unexpected-response', (_req, res) => {
      if (generation !== this.generation) return
      const status = res.statusCode
      const message =
        status === 401 || status === 403
          ? 'Deepgram rejected the connection — check DEEPGRAM_API_KEY.'
          : `Deepgram connection failed (HTTP ${status}).`
      res.resume() // drain so the socket can close cleanly
      this.failFatal(message)
    })

    ws.on('close', (code) => {
      if (generation !== this.generation) return
      this.stopKeepalive()
      if (this.closing) {
        this.emit('closed')
        this.emitStatus('closed')
        return
      }
      if (code === 1000 || code === 1005) {
        // A clean close we didn't initiate (e.g. Deepgram ended the
        // stream on its own after a final result) — not an error.
        this.emit('closed')
        this.emitStatus('closed')
        return
      }
      this.deps.logError('deepgram', `closed unexpectedly with code ${code}`)
      this.maybeReconnect(`closed unexpectedly (code ${code})`)
    })
  }

  private maybeReconnect(reason: string): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.failFatal(`Lost connection to speech recognition after ${MAX_RECONNECT_ATTEMPTS} attempts (${this.lastError ?? reason}).`)
      return
    }
    const gate = this.deps.checkBudget()
    if (!gate.allowed) {
      this.failFatal(gate.reason ?? 'Voice input is disabled by the budget limit.')
      return
    }
    this.reconnectAttempts++
    const delay = backoffDelayMs(this.reconnectAttempts - 1)
    this.deps.logInfo('deepgram', `reconnecting (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms — ${reason}`)
    this.emitStatus('reconnecting')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.closing) this.connect()
    }, delay)
  }

  private failFatal(message: string): void {
    this.lastError = message
    this.emitStatus('error')
    this.emit('error', new Error(message))
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    // Deepgram closes an idle streaming connection after a short window
    // with no audio at all — a real pause in conversation (thinking,
    // reading a reply) can exceed that even though the session is still
    // very much alive. An explicit KeepAlive message holds the socket
    // open without sending fake audio.
    this.keepaliveTimer = setInterval(() => {
      if (this.ready && this.ws?.readyState === SOCKET_OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }))
      }
    }, KEEPALIVE_INTERVAL_MS)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private emitStatus(state: TransportStatus['state']): void {
    this.emit('status', {
      provider: 'deepgram',
      state,
      retryCount: this.reconnectAttempts,
      lastError: this.lastError,
      updatedAt: Date.now()
    } satisfies TransportStatus)
  }

  private static readonly MAX_QUEUED_CHUNKS = 50 // ~4s of audio at 80ms/chunk — a connection that never opens shouldn't leak memory

  sendAudio(chunk: Buffer): void {
    if (this.closing) return
    if (this.ready && this.ws?.readyState === SOCKET_OPEN) {
      this.ws.send(chunk)
    } else {
      this.queue.push(chunk)
      if (this.queue.length > DeepgramStt.MAX_QUEUED_CHUNKS) this.queue.shift()
    }
  }

  stop(): void {
    if (this.closing) return
    this.closing = true
    this.queue = []
    this.stopKeepalive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (!this.ws) return
    if (this.ws.readyState === SOCKET_OPEN) {
      this.ws.send(JSON.stringify({ type: 'CloseStream' }))
      // Give Deepgram a moment to flush the final transcript before we close.
      setTimeout(() => this.ws?.close(), 400)
    } else {
      this.ws.close()
    }
  }
}
