import { dirname, join, sep } from 'path'
import { config } from '../config'
import { logInfo, logError } from '../logger'

/**
 * @picovoice/porcupine-node resolves its model (.pv) and keyword (.ppn)
 * files with `path.resolve(__dirname, ...)`, then hands the resulting
 * string to the native addon's own file I/O — which does a raw fopen()
 * that has no idea what an asar archive is. Electron's fs patching (and
 * its .node-specific unpack redirect) only covers Node-level `fs`/require
 * calls, not that raw native fopen, so a path like
 * ".../app.asar/node_modules/@picovoice/.../jarvis_mac.ppn" fails with a
 * real IO error even though asarUnpack put a genuine copy right next to
 * it at ".../app.asar.unpacked/...". Confirmed by an actual packaged
 * smoke test (v0.5.0-test.1's dev pass) — this isn't a hypothetical.
 * Fix: rewrite any asar-internal path onto its unpacked mirror before it
 * ever reaches the native layer. In dev (no asar at all) this is a no-op.
 */
function toUnpackedPath(p: string): string {
  const asarSegment = `app.asar${sep}`
  const unpackedSegment = `app.asar.unpacked${sep}`
  if (p.includes(asarSegment) && !p.includes(unpackedSegment)) {
    return p.replace(asarSegment, unpackedSegment)
  }
  return p
}

export interface WakeWordStatus {
  /** True once the engine has been constructed successfully and can process audio. */
  ready: boolean
  /** Set when construction failed or no AccessKey is configured — the reason Presence falls back to hotkey-only. */
  error: string | null
  frameLength: number | null
  sampleRate: number | null
}

/**
 * Thin wrapper around @picovoice/porcupine-node's built-in "Jarvis" keyword
 * — see the plan's Presence/Hands-Free phase for why Porcupine: prebuilt,
 * platform-specific N-API binaries (no node-gyp/electron-rebuild needed,
 * consistent with this project's `npmRebuild: false`), fully local/offline
 * keyword spotting (no audio ever leaves the device to detect the wake
 * word), and a ready-made "Jarvis" keyword file so no custom model
 * training is needed.
 *
 * Requires a free AccessKey from Picovoice Console (PICOVOICE_ACCESS_KEY —
 * see config.ts): without one, `start()` fails gracefully and Presence
 * simply stays disabled, falling back to the existing Control+Space
 * hotkey — this is never a hard requirement for JARVIS to work.
 */
export class WakeWordEngine {
  // `any`-typed: the module's own .d.ts pulls in @picovoice/porcupine-node's
  // types at compile time, which is fine, but the instance is otherwise
  // opaque here — this file only ever calls .process()/.release() on it.
  private instance: { frameLength: number; sampleRate: number; process(frame: Int16Array): number; release(): void } | null = null
  private lastError: string | null = null

  start(): WakeWordStatus {
    if (this.instance) return this.status()
    if (!config.picovoiceAccessKey) {
      this.lastError = 'No Picovoice AccessKey configured (PICOVOICE_ACCESS_KEY) — wake word is disabled.'
      return this.status()
    }
    try {
      // Lazy require — never touched at all when there's no AccessKey, so a
      // machine with no key configured never even loads the native addon.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Porcupine, BuiltinKeyword, getBuiltinKeywordPath } = require('@picovoice/porcupine-node')
      const pkgDir = toUnpackedPath(dirname(require.resolve('@picovoice/porcupine-node/package.json')))
      const modelPath = toUnpackedPath(join(pkgDir, 'lib', 'common', 'porcupine_params.pv'))
      const keywordPath = toUnpackedPath(getBuiltinKeywordPath(BuiltinKeyword.JARVIS))
      this.instance = new Porcupine(config.picovoiceAccessKey, [keywordPath], [config.wakeWordSensitivity], { modelPath })
      this.lastError = null
      logInfo('presence:wakeword', `engine ready (frameLength=${this.instance!.frameLength}, sampleRate=${this.instance!.sampleRate})`)
    } catch (err) {
      this.instance = null
      this.lastError = err instanceof Error ? err.message : String(err)
      logError('presence:wakeword', `failed to initialize: ${this.lastError}`)
    }
    return this.status()
  }

  stop(): void {
    if (this.instance) {
      try {
        this.instance.release()
      } catch {
        // Best-effort — release() only frees native memory, never leave the app stuck over it.
      }
      this.instance = null
    }
  }

  status(): WakeWordStatus {
    return {
      ready: this.instance !== null,
      error: this.lastError,
      frameLength: this.instance?.frameLength ?? null,
      sampleRate: this.instance?.sampleRate ?? null
    }
  }

  /** Returns true the instant the "Jarvis" keyword is detected in this frame. `frame.length` must equal `status().frameLength`. */
  processFrame(frame: Int16Array): boolean {
    if (!this.instance) return false
    try {
      return this.instance.process(frame) !== -1
    } catch (err) {
      logError('presence:wakeword', `process() failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}

export const wakeWordEngine = new WakeWordEngine()
