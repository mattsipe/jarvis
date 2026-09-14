import { app } from 'electron'
import { InferenceSession, Tensor } from 'onnxruntime-node'
import { join } from 'path'
import { logInfo, logError } from '../logger'
import { sensitivityToThreshold, ConsecutiveFrameGate, RollingPeak } from './wakewordMath'
import { getPresenceConfig } from './config'

export interface WakeWordStatus {
  ready: boolean
  error: string | null
  frameLength: number | null
  sampleRate: number | null
  /** Total frames processed since the engine started (or last reset()) — the diagnostic proof that audio is actually reaching the model at all. */
  framesProcessed: number
  /** This frame's raw classifier score (0-1), before thresholding — null until the buffers have warmed up enough to produce one. */
  lastScore: number | null
  /** Max score over roughly the last 5 seconds — "is it hearing anything close, just not enough" without needing a live log. */
  recentPeakScore: number
  /** Current threshold, derived from the live (panel-editable) sensitivity setting — shown next to the scores above so they're directly comparable. */
  threshold: number
}

const SAMPLE_RATE = 16000
/** 80ms @ 16kHz — the unit processFrame() operates on; presence/index.ts's FrameBuffer slices renderer audio into exactly this size (it reads frameLength from status(), so this is the only place this number needs to live). */
const FRAME_SAMPLES = 1280
/** 160*3 — extra raw-audio lookback the melspectrogram model needs before each new frame, matching openWakeWord's own streaming implementation (openwakeword/utils.py's `_streaming_melspectrogram`). */
const MEL_LOOKBACK_SAMPLES = 480
const MEL_BINS = 32
/** Sliding window of mel frames the embedding model consumes. */
const MEL_WINDOW_FRAMES = 76
/** How many new mel frames one 1280-sample audio frame produces in steady state. */
const MEL_STEP_FRAMES = 8
const EMBEDDING_DIM = 96
/** Sliding window of embeddings the "hey jarvis" classifier consumes. */
const CLASSIFIER_WINDOW = 16
/** openWakeWord's own reference implementation zeroes the first few predictions after (re)starting while the sliding-window buffers settle. */
const WARMUP_PREDICTIONS = 5
/** Length of the random-noise clip used to prime the embedding buffer at startup — see primeBuffers(). Matches openWakeWord's own priming clip length. */
const PRIME_SECONDS = 4

/**
 * A packaged build places these via electron-builder's `extraResources`
 * (see electron-builder.yml) at a REAL path outside the asar archive —
 * process.resourcesPath, the same mechanism platform/helper.ts already
 * uses for jarvis-helper.exe. Deliberately not `join(__dirname, ...)`:
 * that would resolve inside the (virtual, asar-packed) bundled main
 * process code, which onnxruntime-node's native addon can't open — its
 * own file I/O has no idea what an asar archive is. Confirmed by an
 * actual packaged smoke test, not assumed (see the commit message).
 */
function resourcePath(filename: string): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'wakeword') : join(__dirname, '../../resources/wakeword')
  return join(base, filename)
}

function melspecTransform(v: number): number {
  // The ONNX melspectrogram model's output sits in a different numerical
  // range than the TFLite one the classifier was actually trained against
  // (a known, documented openWakeWord quirk) — this is the same correction
  // factor openwakeword/utils.py applies by default.
  return v / 10 + 2
}

/**
 * Local, fully offline wake-word detection using openWakeWord's official
 * "hey jarvis" model (see resources/wakeword/NOTICE.md) run through ONNX
 * Runtime's Node binding — no account, API key, or network access needed,
 * during or after installation. Replaces the earlier Picovoice-based
 * engine behind the exact same public interface (start/stop/status/
 * processFrame/reset) — see presence/index.ts — so another engine could be
 * swapped in the same way again later.
 *
 * openWakeWord's own pipeline is three chained ONNX models (raw audio ->
 * melspectrogram -> speech embedding -> keyword classifier); there's no
 * official Node/JS runtime for the streaming glue between them (only the
 * models themselves are published), so this reimplements that streaming
 * buffering logic directly from openWakeWord's Python reference
 * (openwakeword/utils.py's AudioFeatures class and openwakeword/model.py's
 * Model.predict) rather than depending on a third-party JS port — the
 * exact tensor shapes below were confirmed by actually running these ONNX
 * files during development, not guessed from reading the Python source
 * alone (see the commit message).
 */
class WakeWordEngine {
  private melspecSession: InferenceSession | null = null
  private embeddingSession: InferenceSession | null = null
  private classifierSession: InferenceSession | null = null
  private lastError: string | null = null
  private starting = false

  // Streaming state — mirrors openWakeWord's AudioFeatures buffers.
  private rawContext = new Float32Array(0) // trailing raw samples carried into the next frame's melspec call, for lookback context
  private melBuffer: number[][] = [] // each entry: one mel frame (MEL_BINS numbers)
  private featureBuffer: number[][] = [] // each entry: one embedding (EMBEDDING_DIM numbers)
  private predictionCount = 0
  private gate = new ConsecutiveFrameGate(getPresenceConfig().consecutiveFrames)

  // Diagnostics — see WakeWordStatus. Tracked unconditionally (cheap) so
  // the Presence panel always has a real answer to "is audio actually
  // reaching the model, and how close is it" instead of a guess.
  private framesProcessed = 0
  private lastScore: number | null = null
  private recentPeak = new RollingPeak(60) // ~4.8s at one 80ms frame each

  async start(): Promise<WakeWordStatus> {
    if (this.status().ready || this.starting) return this.status()
    this.starting = true
    try {
      const opts: InferenceSession.SessionOptions = { executionProviders: ['cpu'], interOpNumThreads: 1, intraOpNumThreads: 1 }
      const [melspecSession, embeddingSession, classifierSession] = await Promise.all([
        InferenceSession.create(resourcePath('melspectrogram.onnx'), opts),
        InferenceSession.create(resourcePath('embedding_model.onnx'), opts),
        InferenceSession.create(resourcePath('hey_jarvis_v0.1.onnx'), opts)
      ])
      this.melspecSession = melspecSession
      this.embeddingSession = embeddingSession
      this.classifierSession = classifierSession
      await this.primeBuffers()
      this.lastError = null
      logInfo('presence:wakeword', 'openWakeWord "hey jarvis" engine ready (local, offline)')
    } catch (err) {
      this.melspecSession = null
      this.embeddingSession = null
      this.classifierSession = null
      this.lastError = err instanceof Error ? err.message : String(err)
      logError('presence:wakeword', `failed to initialize: ${this.lastError}`)
    } finally {
      this.starting = false
    }
    return this.status()
  }

  stop(): void {
    this.melspecSession = null
    this.embeddingSession = null
    this.classifierSession = null
    this.clearBuffers()
  }

  status(): WakeWordStatus {
    const ready = this.melspecSession !== null && this.embeddingSession !== null && this.classifierSession !== null
    return {
      ready,
      error: this.lastError,
      frameLength: FRAME_SAMPLES,
      sampleRate: SAMPLE_RATE,
      framesProcessed: this.framesProcessed,
      lastScore: this.lastScore,
      recentPeakScore: this.recentPeak.peak(),
      threshold: sensitivityToThreshold(getPresenceConfig().sensitivity)
    }
  }

  /** Discards in-flight buffering and re-primes — called whenever Presence stops actively listening (woke, muted), so stale audio/near-threshold state never leaks into the next listening period. Fire-and-forget: priming is a few ms of local inference, never worth making every caller await. */
  reset(): void {
    this.clearBuffers()
    if (this.status().ready) void this.primeBuffers()
  }

  private clearBuffers(): void {
    this.rawContext = new Float32Array(0)
    this.melBuffer = []
    this.featureBuffer = []
    this.predictionCount = 0
    this.gate.reset()
    // lastScore/recentPeak reset with the listening period they describe —
    // framesProcessed deliberately does NOT reset here, it's a lifetime
    // "has audio ever actually reached this engine at all" counter.
    this.lastScore = null
    this.recentPeak.reset()
  }

  /**
   * Seeds the mel-frame buffer with placeholder frames and the embedding
   * buffer with real embeddings computed from a few seconds of random
   * noise — exactly mirrors openWakeWord's own AudioFeatures priming.
   * Without this, detection would need several seconds of real audio to
   * naturally fill both sliding windows before ever producing a score —
   * a startup delay every time Presence resumes listening.
   */
  private async primeBuffers(): Promise<void> {
    this.melBuffer = Array.from({ length: MEL_WINDOW_FRAMES }, () => new Array(MEL_BINS).fill(1))

    const noiseSamples = PRIME_SECONDS * SAMPLE_RATE
    const noise = new Float32Array(noiseSamples)
    for (let i = 0; i < noiseSamples; i++) noise[i] = Math.floor(Math.random() * 2001) - 1000

    const melFrames = await this.runMelspec(noise)
    const windows: number[][] = []
    for (let i = 0; i + MEL_WINDOW_FRAMES <= melFrames.length; i += MEL_STEP_FRAMES) {
      windows.push(melFrames.slice(i, i + MEL_WINDOW_FRAMES).flat())
    }
    if (windows.length > 0) this.featureBuffer = await this.runEmbeddingBatch(windows, MEL_WINDOW_FRAMES)
  }

  /** Returns true the instant "hey jarvis" is detected in this frame. `frame.length` must equal `status().frameLength`. */
  async processFrame(frame: Int16Array): Promise<boolean> {
    if (!this.melspecSession || !this.embeddingSession || !this.classifierSession) return false
    this.framesProcessed++
    try {
      const frameFloat = Float32Array.from(frame)
      const input = new Float32Array(this.rawContext.length + frameFloat.length)
      input.set(this.rawContext)
      input.set(frameFloat, this.rawContext.length)

      const newMelFrames = await this.runMelspec(input)
      this.melBuffer.push(...newMelFrames)
      if (this.melBuffer.length > MEL_WINDOW_FRAMES * 3) this.melBuffer = this.melBuffer.slice(-MEL_WINDOW_FRAMES * 3)
      this.rawContext = input.slice(-MEL_LOOKBACK_SAMPLES)

      if (this.melBuffer.length < MEL_WINDOW_FRAMES) return false

      const [embedding] = await this.runEmbeddingBatch([this.melBuffer.slice(-MEL_WINDOW_FRAMES).flat()], MEL_WINDOW_FRAMES)
      this.featureBuffer.push(embedding)
      if (this.featureBuffer.length > CLASSIFIER_WINDOW * 3) this.featureBuffer = this.featureBuffer.slice(-CLASSIFIER_WINDOW * 3)

      if (this.featureBuffer.length < CLASSIFIER_WINDOW) return false

      const score = await this.runClassifier(this.featureBuffer.slice(-CLASSIFIER_WINDOW))
      this.lastScore = score
      this.recentPeak.push(score)

      this.predictionCount++
      if (this.predictionCount <= WARMUP_PREDICTIONS) return false

      const cfg = getPresenceConfig()
      this.gate.setRequired(cfg.consecutiveFrames)
      return this.gate.observe(score, sensitivityToThreshold(cfg.sensitivity))
    } catch (err) {
      logError('presence:wakeword', `processFrame failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  private async runMelspec(samples: Float32Array): Promise<number[][]> {
    const session = this.melspecSession!
    const tensor = new Tensor('float32', samples, [1, samples.length])
    const result = await session.run({ [session.inputNames[0]]: tensor })
    const data = result[session.outputNames[0]].data as Float32Array
    const nFrames = Math.floor(data.length / MEL_BINS)
    const frames: number[][] = []
    for (let f = 0; f < nFrames; f++) {
      const row = new Array<number>(MEL_BINS)
      for (let b = 0; b < MEL_BINS; b++) row[b] = melspecTransform(data[f * MEL_BINS + b])
      frames.push(row)
    }
    return frames
  }

  private async runEmbeddingBatch(windows: number[][], windowFrames: number): Promise<number[][]> {
    const session = this.embeddingSession!
    const batch = windows.length
    const flat = new Float32Array(batch * windowFrames * MEL_BINS)
    for (let i = 0; i < batch; i++) flat.set(windows[i], i * windowFrames * MEL_BINS)
    const tensor = new Tensor('float32', flat, [batch, windowFrames, MEL_BINS, 1])
    const result = await session.run({ [session.inputNames[0]]: tensor })
    const data = result[session.outputNames[0]].data as Float32Array
    const embeddings: number[][] = []
    for (let i = 0; i < batch; i++) embeddings.push(Array.from(data.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM)))
    return embeddings
  }

  private async runClassifier(window: number[][]): Promise<number> {
    const session = this.classifierSession!
    const flat = new Float32Array(CLASSIFIER_WINDOW * EMBEDDING_DIM)
    for (let i = 0; i < CLASSIFIER_WINDOW; i++) flat.set(window[i], i * EMBEDDING_DIM)
    const tensor = new Tensor('float32', flat, [1, CLASSIFIER_WINDOW, EMBEDDING_DIM])
    const result = await session.run({ [session.inputNames[0]]: tensor })
    return (result[session.outputNames[0]].data as Float32Array)[0]
  }
}

export const wakeWordEngine = new WakeWordEngine()
