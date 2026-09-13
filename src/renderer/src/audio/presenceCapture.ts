/**
 * Continuous, low-overhead mic capture used ONLY for local wake-word
 * detection while Presence is "sleeping" — see main/presence/. Forces the
 * AudioContext to 16kHz (Porcupine's required sample rate); Chromium
 * resamples the raw mic signal to the context's rate internally, so the
 * PCM16 frames sent here are already at the right rate with no resampling
 * code needed on this side. Deliberately much simpler than MicCapture
 * (audio/capture.ts): no VAD, no barge-in, no amplitude/HUD reactivity —
 * just raw PCM to main, which buffers it into Porcupine-sized frames
 * itself (see presence/frameBuffer.ts).
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
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.processor = this.ctx.createScriptProcessor(2048, 1, 1)

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const input = e.inputBuffer.getChannelData(0)
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
