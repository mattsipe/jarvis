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
  private activeSources = new Set<AudioBufferSourceNode>()
  private streamEnded = false
  private aborted = false
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
    if (this.aborted) return
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

    this.activeSources.add(source)
    source.onended = () => {
      this.activeSources.delete(source)
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

  /**
   * Barge-in: immediately silences whatever is playing/queued and
   * prevents markStreamEnded's callback from firing for this (now
   * superseded) reply. Stopping an AudioBufferSourceNode mid-playback is
   * synchronous and near-instant — this is what makes the cutoff feel
   * immediate rather than waiting for the current chunk to finish.
   */
  abort(): void {
    this.aborted = true
    this.finishedCallback = null
    for (const source of this.activeSources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already stopped/ended — fine, that's the state we want anyway.
      }
    }
    this.activeSources.clear()
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
    setAmplitude(null)
  }

  close(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId)
    this.ctx.close()
    setAmplitude(null)
  }

  private checkFinished(): void {
    if (this.activeSources.size === 0 && this.streamEnded && !this.aborted) {
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

      if (this.activeSources.size > 0 || !this.streamEnded) {
        this.rafId = requestAnimationFrame(tick)
      } else {
        this.rafId = null
        setAmplitude(null)
      }
    }
    this.rafId = requestAnimationFrame(tick)
  }
}
