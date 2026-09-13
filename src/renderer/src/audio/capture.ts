import { setAmplitude } from '../hud/core/amplitudeBus'

export type CaptureMode = 'stream' | 'monitor'

/**
 * getUserMedia rejects with a generic-looking DOMException whose `name`
 * is the only useful signal — turned into a plain-language reason so a
 * mic failure is diagnosable instead of just "the core went red" (see the
 * Windows voice-startup investigation: OS-level mic privacy settings and
 * missing Electron permission handling are both real, platform-specific
 * ways this fails silently otherwise).
 */
export function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access was denied. Check your OS privacy settings (Windows: Settings → Privacy → Microphone) and this app’s permission there, then try again.'
    case 'NotFoundError':
      return 'No microphone was found. Check that a recording device is connected and set as available.'
    case 'NotReadableError':
      return 'The microphone is in use by another application or the audio device failed to start.'
    case 'OverconstrainedError':
      return 'No microphone matched the requested audio settings.'
    default:
      return err instanceof Error ? err.message : String(err)
  }
}

// VAD tuning for barge-in detection while in 'monitor' mode. Raw RMS
// (pre `*4` HUD scaling), needs sustained frames above threshold to avoid
// a single transient/glitch triggering it. echoCancellation (enabled
// below) is the primary defense against JARVIS hearing itself; this is a
// secondary filter on top of that. Untuned against a real mic/room yet —
// the first thing to adjust if it's too twitchy or too deaf in practice.
const VAD_THRESHOLD = 0.02
const VAD_FRAMES_TO_TRIGGER = 2
const PREROLL_CHUNKS = 3 // ~250-350ms at 4096 samples/callback, sent first so the interruption's opening words aren't clipped

/**
 * Captures the microphone for the life of one conversation session (not
 * recreated per turn — see App.tsx). In 'stream' mode it behaves as
 * before: live RMS drives the HUD's "listening" reactivity and raw PCM16
 * streams to main for Deepgram. In 'monitor' mode (while JARVIS is
 * thinking/speaking) it does neither — it only watches for a sustained
 * amplitude spike (the user talking over it) and fires onBargeIn, along
 * with a short pre-roll buffer of what was just captured.
 *
 * Uses ScriptProcessorNode (deprecated but zero-config, no separate
 * worklet module to bundle/serve) — fine for an MVP; AudioWorklet is the
 * natural upgrade if processing overhead ever becomes a problem.
 */
export class MicCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null

  private mode: CaptureMode = 'stream'
  private onBargeIn: ((preroll: ArrayBuffer[]) => void) | null = null
  private framesAboveThreshold = 0
  private prerollBuffer: ArrayBuffer[] = []

  /** Requests the mic and sets up the audio graph. Returns the context's native sample rate. */
  async start(): Promise<number> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    })
    this.ctx = new AudioContext()
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0)

      let sumSquares = 0
      for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i]
      const rms = Math.sqrt(sumSquares / input.length)

      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }

      if (this.mode === 'stream') {
        setAmplitude(Math.min(1, rms * 4))
        window.jarvis.sendAudioChunk(pcm.buffer)
      } else {
        // Monitor mode: keep a short rolling pre-roll, watch for sustained speech.
        this.prerollBuffer.push(pcm.buffer)
        if (this.prerollBuffer.length > PREROLL_CHUNKS) this.prerollBuffer.shift()

        if (rms > VAD_THRESHOLD) {
          this.framesAboveThreshold++
          if (this.framesAboveThreshold >= VAD_FRAMES_TO_TRIGGER) {
            this.framesAboveThreshold = 0
            const preroll = this.prerollBuffer
            this.prerollBuffer = []
            this.onBargeIn?.(preroll)
          }
        } else {
          this.framesAboveThreshold = 0
        }
      }
    }

    // ScriptProcessorNode only fires once connected through to a destination.
    // Route through a silent gain so the raw mic signal is never audible
    // (connecting straight to ctx.destination would cause audible feedback).
    this.silentGain = this.ctx.createGain()
    this.silentGain.gain.value = 0
    this.silentGain.connect(this.ctx.destination)

    return this.ctx.sampleRate
  }

  /** Call once main has opened the STT connection at the sample rate from start(). */
  beginStreaming(): void {
    if (!this.source || !this.processor || !this.silentGain) return
    this.source.connect(this.processor)
    this.processor.connect(this.silentGain)
  }

  /** Switch between full streaming (listening) and barge-in-only monitoring (thinking/speaking). */
  setMode(mode: CaptureMode): void {
    this.mode = mode
    this.framesAboveThreshold = 0
    this.prerollBuffer = []
    if (mode === 'stream') setAmplitude(0)
    else setAmplitude(null) // let TTS's own AnalyserNode own "speaking" reactivity
  }

  /** Registered once per session; called from monitor mode with a short pre-roll of raw PCM16. */
  setBargeInHandler(handler: ((preroll: ArrayBuffer[]) => void) | null): void {
    this.onBargeIn = handler
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0
  }

  stop(): void {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.silentGain?.disconnect()
    this.ctx?.close()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.ctx = null
    this.source = null
    this.processor = null
    this.silentGain = null
    this.onBargeIn = null
    setAmplitude(null)
  }
}
