import { downsampleTo16k } from './resample'

/**
 * Continuous, low-overhead mic capture used ONLY for local wake-word
 * detection while Presence is "sleeping" — see main/presence/. Deliberately
 * much simpler than MicCapture (audio/capture.ts): no VAD, no barge-in, no
 * amplitude/HUD reactivity — just PCM to main, which buffers it into the
 * engine's frame size itself (see presence/frameBuffer.ts).
 *
 * Requests a 16kHz AudioContext, but does NOT assume Chromium actually
 * granted it — `sampleRate` in AudioContextOptions is a request, not a
 * guarantee, and Windows commonly forces the device's native rate (44100
 * or 48000) regardless. Sending audio at the wrong rate produces no error
 * at all, just audio the wake-word model can never match — so the actual
 * achieved `ctx.sampleRate` is always checked, resampled to 16kHz with
 * downsampleTo16k() when it doesn't match, and reported to main via
 * reportPresenceMicStatus() so the Presence panel can show the real
 * numbers instead of an assumption.
 *
 * Ownership: this must never run at the same time as MicCapture's stream —
 * see App.tsx, which starts/stops this strictly based on Presence's
 * broadcast state (only ever 'sleeping') and always stops it before a
 * conversation's own MicCapture starts.
 */
export class PresenceMicCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
    })
    this.ctx = new AudioContext({ sampleRate: 16000 })
    const actualSampleRate = this.ctx.sampleRate
    const track = this.stream.getAudioTracks()[0]
    const trackSettings = track?.getSettings?.() ?? {}

    window.jarvis.reportPresenceMicStatus({
      requestedSampleRate: 16000,
      actualContextSampleRate: actualSampleRate,
      trackSampleRate: typeof trackSettings.sampleRate === 'number' ? trackSettings.sampleRate : null,
      channelCount: typeof trackSettings.channelCount === 'number' ? trackSettings.channelCount : 1,
      deviceLabel: track?.label || null,
      resampling: actualSampleRate !== 16000
    })

    this.source = this.ctx.createMediaStreamSource(this.stream)
    // 4096 @ whatever the context's real rate is (matches audio/capture.ts's
    // MicCapture buffer size) — plenty of margin even at 48kHz (~85ms/callback).
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1)

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const raw = e.inputBuffer.getChannelData(0)
      const input = actualSampleRate === 16000 ? raw : downsampleTo16k(raw, actualSampleRate)
      const pcm = new Int16Array(input.length)
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]))
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      window.jarvis.sendPresenceAudioChunk(pcm.buffer)
    }

    this.source.connect(this.processor)
    // ScriptProcessorNode only fires once connected through to a
    // destination — routed through a silent gain so this is never audible.
    this.silentGain = this.ctx.createGain()
    this.silentGain.gain.value = 0
    this.processor.connect(this.silentGain)
    this.silentGain.connect(this.ctx.destination)
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
  }
}
