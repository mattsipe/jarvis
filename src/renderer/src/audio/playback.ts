import { setAmplitude } from '../hud/core/amplitudeBus'

/**
 * Schedules ElevenLabs' streamed PCM16/16kHz chunks for gapless playback
 * and drives the HUD's "speaking" reactivity from a live AnalyserNode on
 * the actual output — not a simulated pulse, and not per-chunk timing
 * math, so it stays correct regardless of how ElevenLabs chunks the audio.
 */
export class TtsPlayback {
  private ctx: AudioContext
  private analyser: AnalyserNode
  private dataArray: Uint8Array<ArrayBuffer>
  private nextStartTime: number
  private pendingSources = 0
  private streamEnded = false
  private rafId: number | null = null
  private finishedCallback: (() => void) | null = null

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 16000 })
    if (this.ctx.sampleRate !== 16000) {
      console.warn(
        `[jarvis] playback AudioContext sample rate is ${this.ctx.sampleRate}, not 16000 — TTS audio will sound pitch-shifted.`
      )
    }
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.analyser.connect(this.ctx.destination)
    this.dataArray = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))
    this.nextStartTime = this.ctx.currentTime
  }

  enqueue(chunk: ArrayBuffer): void {
    const int16 = new Int16Array(chunk)
    if (int16.length === 0) return
    const float32 = new Float32Array(int16.length)
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000

    const buffer = this.ctx.createBuffer(1, float32.length, 16000)
    buffer.copyToChannel(float32, 0)

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.analyser)

    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime)
    source.start(startAt)
    this.nextStartTime = startAt + buffer.duration

    this.pendingSources++
    source.onended = () => {
      this.pendingSources--
      this.checkFinished()
    }

    this.ensureAmplitudeLoop()
  }

  /** Call once main signals no more audio chunks are coming for this reply. */
  markStreamEnded(onFullyEnded: () => void): void {
    this.streamEnded = true
    this.finishedCallback = onFullyEnded
    this.checkFinished()
  }

  close(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.ctx.close()
    setAmplitude(null)
  }

  private checkFinished(): void {
    if (this.pendingSources === 0 && this.streamEnded) {
      this.finishedCallback?.()
    }
  }

  private ensureAmplitudeLoop(): void {
    if (this.rafId !== null) return
    const tick = (): void => {
      this.analyser.getByteTimeDomainData(this.dataArray)
      let sumSquares = 0
      for (let i = 0; i < this.dataArray.length; i++) {
        const v = (this.dataArray[i] - 128) / 128
        sumSquares += v * v
      }
      const rms = Math.sqrt(sumSquares / this.dataArray.length)
      setAmplitude(Math.min(1, rms * 4))

      if (this.pendingSources > 0 || !this.streamEnded) {
        this.rafId = requestAnimationFrame(tick)
      } else {
        this.rafId = null
        setAmplitude(null)
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }
}
