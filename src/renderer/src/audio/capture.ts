import { setAmplitude } from '../hud/core/amplitudeBus'

/**
 * Captures the microphone, feeds live RMS amplitude to the HUD core (real
 * "listening" reactivity, replacing M1's simulated pulse), and streams
 * raw 16-bit PCM to main for Deepgram over IPC.
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
      setAmplitude(Math.min(1, rms * 4))

      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      window.jarvis.sendAudioChunk(pcm.buffer)
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
    setAmplitude(null)
  }
}
