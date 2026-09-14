export interface ExternalWindowRef {
  hwnd: number
  pid: number
  title: string
  process: string
}

export interface LastTarget {
  ref: string
  name: string | null
  role: string | null
  window: string | null
  lastAction: string
  lastVerifiedState: string | null
  at: number
}

export interface CaptureRecord {
  captureId: string
  hwnd: number
  windowTitle: string | null
  capturedAt: number
  region: { x: number; y: number; width: number; height: number }
  scale: number
}

const CAPTURE_MAX_AGE_MS = 10_000
const TARGET_MAX_AGE_MS = 5 * 60 * 1000
const MAX_CAPTURES = 2

/**
 * Short-lived, in-memory state for one conversation's worth of Operate
 * activity — never persisted, reset between sessions. This is what makes
 * "click that" and "turn it back off" work without Claude re-sending a
 * whole UI snapshot, and what gates pointer_act's fallback (a capture must
 * be fresh, and a UIA failure must actually be on record for this exact
 * window/target before a coordinate click is allowed). No Electron
 * imports — `now` is injectable so this is directly unit-testable.
 */
export class OperateContext {
  private lastExternalWindowRef: ExternalWindowRef | null = null
  private lastTargetRef: LastTarget | null = null
  private captureList: CaptureRecord[] = []
  private uiaFailures = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  recordExternalWindow(w: ExternalWindowRef): void {
    this.lastExternalWindowRef = w
  }

  getLastExternalWindow(): ExternalWindowRef | null {
    return this.lastExternalWindowRef
  }

  recordTarget(t: Omit<LastTarget, 'at'>): void {
    this.lastTargetRef = { ...t, at: this.now() }
  }

  getLastTarget(): LastTarget | null {
    if (!this.lastTargetRef) return null
    if (this.now() - this.lastTargetRef.at > TARGET_MAX_AGE_MS) return null
    return this.lastTargetRef
  }

  recordCapture(capture: CaptureRecord): void {
    this.captureList = [capture, ...this.captureList].slice(0, MAX_CAPTURES)
  }

  getCapture(captureId: string): CaptureRecord | null {
    return this.captureList.find((c) => c.captureId === captureId) ?? null
  }

  /** The freshness half of pointer_act's fallback gate — see operate/risk.ts's sibling gate (a recorded UIA failure) for the other half. */
  isCaptureFresh(captureId: string): boolean {
    const capture = this.getCapture(captureId)
    return capture != null && this.now() - capture.capturedAt <= CAPTURE_MAX_AGE_MS
  }

  /** Keyed by window + a description of what was being targeted — deliberately coarse (not the exact locator), since the point is "has UIA already been tried and failed here at all", not exact-match bookkeeping. */
  recordUiaFailure(hwnd: number, targetDescription: string): void {
    const key = `${hwnd}|${targetDescription.toLowerCase()}`
    this.uiaFailures.set(key, (this.uiaFailures.get(key) ?? 0) + 1)
  }

  hasUiaFailure(hwnd: number, targetDescription: string): boolean {
    return (this.uiaFailures.get(`${hwnd}|${targetDescription.toLowerCase()}`) ?? 0) > 0
  }

  reset(): void {
    this.lastExternalWindowRef = null
    this.lastTargetRef = null
    this.captureList = []
    this.uiaFailures.clear()
  }

  /** Injected into the system prompt every turn — kept under ~300 chars deliberately, so this never becomes a second UI-tree dump. */
  summary(): string {
    const parts: string[] = []
    const target = this.getLastTarget()
    if (target) {
      const ageSec = Math.round((this.now() - target.at) / 1000)
      const label = [target.role, target.name ? `"${target.name}"` : null].filter(Boolean).join(' ')
      parts.push(
        `Operate: last target ${target.ref} ${label}${target.window ? ` in "${target.window}"` : ''} — ${target.lastVerifiedState ?? 'unknown state'} (${target.lastAction}, ${ageSec}s ago).`
      )
    }
    if (this.lastExternalWindowRef) {
      parts.push(`Last external window: "${this.lastExternalWindowRef.title}".`)
    }
    const summary = parts.join(' ')
    return summary.length > 300 ? summary.slice(0, 297) + '…' : summary
  }
}

/** One shared instance for the app's lifetime — reset when a voice session ends (see voice/session.ts) or presence goes back to sleep, so a new conversation never inherits a stale "click that". */
export const operateContext = new OperateContext()
