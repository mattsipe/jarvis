/**
 * Shared Operate types — mirrors the JSON shapes native/jarvis-helper's
 * Uia/*.cs actually returns (confirmed by compiling against the real
 * FlaUI 5.0.0 API, not guessed). Kept deliberately small: Claude only
 * ever sees compact element summaries and typed results, never a raw
 * accessibility tree — see the plan's "typed tool contracts" section.
 */

export type ElementRole = string // FlaUI ControlType.ToString(), e.g. "Button", "CheckBox" — left as string rather than a closed union since UIA defines ~30 of these and new frameworks can report custom ones.

export interface ElementSummary {
  ref: string
  role: ElementRole | null
  name: string | null
  automationId: string | null
  enabled: boolean
  state: string | null
  patterns: string[]
}

export interface ElementDetail extends ElementSummary {
  className?: string | null
  frameworkId?: string | null
  boundingRect?: { x: number; y: number; width: number; height: number }
}

export interface WindowSummary {
  hwnd: number
  title: string | null
  processName: string | null
  processId?: number
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface InspectResult {
  elements: ElementSummary[]
  window: WindowSummary
  truncated: boolean
}

/** What tools/operate.ts's `ui_act` input accepts — a short-lived ref (preferred once known) or a locator resolved fresh against the live tree. */
export type OperateTarget =
  | { ref: string }
  | { window?: string; name?: string; role?: string; automationId?: string; nth?: number }

export type ActionErrorCode =
  | 'stale_ref'
  | 'ambiguous_target'
  | 'not_found'
  | 'not_actionable'
  | 'disabled'
  | 'timeout'
  | 'stale_capture'
  | 'fallback_not_justified'
  | 'unsupported'

export type VerificationStatus = 'verified' | 'no_effect_observed' | 'not_verifiable' | 'pending'

export interface Verification {
  status: VerificationStatus
  before?: string | null
  after?: string | null
}

export interface ActionResult {
  sent: boolean
  sentVia?: string
  noop?: boolean
  error?: { code: ActionErrorCode; message: string }
  candidates?: ElementSummary[]
  verification: Verification
  element?: ElementSummary
  window?: WindowSummary
}

export interface WaitResult {
  met: boolean
  element?: ElementSummary
  window?: WindowSummary
}

/** One entry per Operate step — TASK → STEP → WINDOW → CONTROL METHOD → TARGET → ACTION → RESULT → VERIFICATION → DURATION, per the plan's diagnostics design. */
export interface OperateStepTrace {
  windowTitle: string | null
  method: string | null
  targetName: string | null
  action: string
  sent: boolean
  verification: VerificationStatus | null
  durationMs: number
  risk: 'safe' | 'moderate' | 'elevated'
  errorCode?: ActionErrorCode
}
