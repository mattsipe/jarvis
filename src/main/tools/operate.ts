import { z } from 'zod'
import type { JarvisTool } from './registry'
import { classifyRisk } from '../operate/risk'
import { operateContext } from '../operate/context'
import { deriveToolOutcome } from '../operate/verification'
import { settingsPageUri, SETTINGS_PAGES, type SettingsPageKey } from '../operate/settingsPages'
import type { ActionResult, ElementDetail, ElementSummary, InspectResult, OperateTarget, WindowSummary } from '../operate/types'

const TargetSchema = z.union([
  z.object({ ref: z.string().describe('A short-lived element ref from a previous ui_inspect/ui_act result, e.g. "e17". Preferred once you have one — cheaper and more precise than re-describing the element.') }),
  z.object({
    window: z.string().optional().describe('"active" (default) for the foreground window, or a substring of its title.'),
    name: z.string().optional().describe('The element\'s visible name/label, e.g. "Bluetooth".'),
    role: z.string().optional().describe('UIA control type, e.g. "Button", "CheckBox", "Edit".'),
    automationId: z.string().optional(),
    nth: z.number().int().min(0).optional().describe('When multiple elements match (e.g. "the second result"), 0-based index into the match order.')
  })
])

function targetLabel(target: OperateTarget, element?: ElementSummary): string {
  if (element) return `"${element.name ?? element.ref}" (${element.role ?? 'element'})`
  if ('ref' in target) return target.ref
  const parts = [target.role, target.name ? `"${target.name}"` : null].filter(Boolean)
  return parts.length > 0 ? parts.join(' ') : 'that element'
}

/** Feeds operate/risk.ts's classifyRisk() from whatever's known about the target right now — a locator target's own fields, or (for a ref) whatever OperateContext last recorded about it. Best-effort; a ref with no recorded history just risk-classifies on intent alone. */
function riskInputFor(target: OperateTarget, intent: string, keys?: string): Parameters<typeof classifyRisk>[0] {
  if ('ref' in target) {
    const last = operateContext.getLastTarget()
    const matches = last?.ref === target.ref
    return {
      intent,
      targetName: matches ? last?.name : null,
      targetRole: matches ? last?.role : null,
      windowTitle: matches ? last?.window : (operateContext.getLastExternalWindow()?.title ?? null),
      keys
    }
  }
  return {
    intent,
    targetName: target.name ?? null,
    targetRole: target.role ?? null,
    windowTitle: target.window && target.window !== 'active' ? target.window : (operateContext.getLastExternalWindow()?.title ?? null),
    keys
  }
}

function recordTargetFromResult(action: string, result: ActionResult): void {
  if (!result.element) return
  operateContext.recordTarget({
    ref: result.element.ref,
    name: result.element.name,
    role: result.element.role,
    window: result.window?.title ?? null,
    lastAction: action,
    lastVerifiedState: result.verification.after ?? result.verification.before ?? null
  })
}

export const uiInspectTool: JarvisTool = {
  name: 'ui_inspect',
  group: 'operate',
  description:
    'See what controls are on the current (or a named) window — a compact list of interactable elements (buttons, toggles, text fields, list items, ...) with a short-lived ref for each, never a raw accessibility tree. Use before ui_act when you don\'t already have a ref. Pass `query` to filter by name (e.g. "bluetooth"). Pass `ref` to get one previously-seen element\'s full detail instead.',
  risk: 'safe',
  input: z.object({
    window: z.string().optional().describe('"active" (default) for the foreground window, or a substring of its title.'),
    query: z.string().optional().describe('Filter to elements whose name/automationId contains this (case-insensitive).'),
    ref: z.string().optional().describe('Get full detail for one specific element ref instead of listing.'),
    maxElements: z.number().int().min(1).max(80).optional()
  }),
  run: async (input, ctx) => {
    if (!ctx.platform.operate) return { ok: false, message: "Operate isn't supported on this platform." }
    try {
      const result = await ctx.platform.operate.inspect(input)
      if ('elements' in result) {
        const inspectResult = result as InspectResult
        if (inspectResult.window.hwnd) {
          operateContext.recordExternalWindow({
            hwnd: inspectResult.window.hwnd,
            pid: inspectResult.window.processId ?? 0,
            title: inspectResult.window.title ?? '',
            process: inspectResult.window.processName ?? ''
          })
        }
        const lines = inspectResult.elements.map(
          (e) => `${e.ref} ${e.role ?? '?'} "${e.name ?? ''}"${e.state ? ` [${e.state}]` : ''}${e.enabled ? '' : ' (disabled)'}`
        )
        return {
          ok: true,
          message:
            lines.length === 0
              ? `No matching elements in "${inspectResult.window.title ?? 'that window'}".`
              : `${lines.length} element(s) in "${inspectResult.window.title ?? 'that window'}"${inspectResult.truncated ? ' (truncated)' : ''}: ${lines.join('; ')}`,
          data: { elements: inspectResult.elements, window: inspectResult.window, truncated: inspectResult.truncated }
        }
      }
      const detail = result as ElementDetail
      return { ok: true, message: `${detail.ref}: ${detail.role ?? '?'} "${detail.name ?? ''}"${detail.state ? ` [${detail.state}]` : ''}`, data: { element: detail } }
    } catch (err) {
      return { ok: false, message: `Couldn't inspect that window: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

const ActInput = z.object({
  target: TargetSchema,
  action: z.enum(['invoke', 'toggle', 'set_value', 'select', 'expand', 'collapse', 'focus', 'scroll']),
  desiredState: z.enum(['on', 'off']).optional().describe('For toggle — makes repeats and "turn it back off" safe: already-matching state is a no-op, not a re-send.'),
  value: z.string().optional().describe('For set_value.'),
  option: z.string().optional().describe('For select, when choosing from a dropdown/combo box by visible option text.'),
  direction: z.enum(['up', 'down', 'into_view']).optional().describe('For scroll.'),
  intent: z.string().describe('One short phrase describing what this accomplishes, e.g. "turn on Bluetooth" — used to decide whether this needs confirmation.'),
  waitMs: z.number().int().min(0).max(5000).optional()
})

export const uiActTool: JarvisTool = {
  name: 'ui_act',
  group: 'operate',
  description:
    'Act on one UI control — toggle, invoke/click, set a value, select an option, expand/collapse, focus, or scroll. Always resolves the target first (by ref, or by name/role/automationId within a window); if more than one element matches, nothing is sent and the real candidates are returned so you can disambiguate (e.g. by nth). toggle/select/expand/collapse take an implicit or explicit desired state, so repeating the same call or asking to "turn it back off" is always safe.',
  risk: (input) => classifyRisk(riskInputFor(input.target, input.intent)).risk,
  input: ActInput,
  run: async (input, ctx) => {
    if (!ctx.platform.operate) return { ok: false, message: "Operate isn't supported on this platform." }
    const result = await ctx.platform.operate.act(input)
    if (!result.sent && result.window?.hwnd && (result.error?.code === 'not_actionable' || result.error?.code === 'not_found' || result.error?.code === 'unsupported')) {
      operateContext.recordUiaFailure(result.window.hwnd, targetLabel(input.target, result.element))
    }
    if (result.sent) recordTargetFromResult(input.action, result)
    const outcome = deriveToolOutcome(result, input.action, targetLabel(input.target, result.element))
    return { ...outcome, data: result.candidates ? { ambiguous: true, candidates: result.candidates } : undefined }
  }
}

export const uiWaitTool: JarvisTool = {
  name: 'ui_wait',
  group: 'operate',
  description:
    'Wait (up to 10s) for a UI condition instead of polling ui_inspect yourself — an element appearing/disappearing, reaching a state, or the active window\'s title containing some text (useful right after opening something that takes a moment to load).',
  risk: 'safe',
  input: z.object({
    condition: z.enum(['appears', 'disappears', 'state', 'window_title']),
    target: TargetSchema.optional().describe('Required for appears/disappears/state.'),
    state: z.string().optional().describe('Required for condition "state", e.g. "On".'),
    titleContains: z.string().optional().describe('Required for condition "window_title".'),
    timeoutMs: z.number().int().min(500).max(10000).default(5000)
  }),
  run: async (input, ctx) => {
    if (!ctx.platform.operate) return { ok: false, message: "Operate isn't supported on this platform." }
    try {
      const result = await ctx.platform.operate.wait(input)
      return { ok: true, message: result.met ? 'Condition met.' : `Condition not met within ${input.timeoutMs}ms.`, data: { met: result.met, element: result.element } }
    } catch (err) {
      return { ok: false, message: `Wait failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

const KeyboardInput = z.object({
  keys: z.string().optional().describe('A key chord, e.g. "Ctrl+S", "Enter", "Escape".'),
  text: z.string().optional().describe('Literal text to type.'),
  target: TargetSchema.optional().describe('Focuses this element first, if given.'),
  intent: z.string().describe('One short phrase describing what this accomplishes — used to decide whether this needs confirmation.')
})

export const keyboardActTool: JarvisTool = {
  name: 'keyboard_act',
  group: 'operate',
  description: 'Send a key chord or type text, optionally focusing a target element first. Prefer ui_act(set_value) for filling in a specific field when possible — use this for chords (Ctrl+S, Enter, Escape) or when a field has no Value pattern.',
  risk: (input) => classifyRisk(riskInputFor(input.target ?? {}, input.intent, input.keys)).risk,
  input: KeyboardInput,
  run: async (input, ctx) => {
    if (!ctx.platform.operate) return { ok: false, message: "Operate isn't supported on this platform." }
    if (!input.keys && !input.text) return { ok: false, message: 'Provide either keys or text.' }
    if (input.target) {
      const focusResult = await ctx.platform.operate.act({ target: input.target, action: 'focus' })
      if (!focusResult.sent) {
        return { ok: false, message: `Couldn't focus ${targetLabel(input.target, focusResult.element)} first: ${focusResult.error?.message ?? 'unknown error'}` }
      }
    }
    try {
      if (input.keys) await ctx.platform.operate.sendKeys(input.keys)
      if (input.text) await ctx.platform.operate.sendText(input.text)
      return { ok: true, message: input.keys ? `Sent ${input.keys}.` : `Typed the text.` }
    } catch (err) {
      return { ok: false, message: `Couldn't send input: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

const PointerInput = z.object({
  captureId: z.string().describe('A captureId from a recent look_at_screen result — this action is rejected if it\'s missing, stale, or the window has moved since.'),
  x: z.number().describe('X coordinate within that captured image.'),
  y: z.number().describe('Y coordinate within that captured image.'),
  action: z.enum(['click', 'double_click', 'right_click', 'scroll']),
  scrollDelta: z.number().optional(),
  fallbackReason: z.string().describe('Why UI Automation could not perform this action — required. This is only for when the control ladder (native tool → UI Automation) genuinely cannot reach the target.'),
  intent: z.string().describe('One short phrase describing what this accomplishes — used to decide whether this needs confirmation.')
})

export const pointerActTool: JarvisTool = {
  name: 'pointer_act',
  group: 'operate',
  description:
    'Last resort: click/scroll at a screen coordinate from a look_at_screen capture, only when UI Automation genuinely cannot operate the target (no accessible control — e.g. a custom-drawn canvas). Requires a fresh capture and a stated reason; rejected outright otherwise. Always prefer ui_act.',
  risk: (input) => classifyRisk({ intent: input.intent }).risk,
  input: PointerInput,
  run: async (input, ctx) => {
    if (!ctx.platform.operate) return { ok: false, message: "Operate isn't supported on this platform." }

    if (!operateContext.isCaptureFresh(input.captureId)) {
      return { ok: false, message: 'That capture is missing or more than 10 seconds old — take a fresh look_at_screen first.' }
    }
    const capture = operateContext.getCapture(input.captureId)!

    let currentWindow: WindowSummary
    try {
      currentWindow = await ctx.platform.operate.fingerprint()
    } catch (err) {
      return { ok: false, message: `Couldn't confirm the window is unchanged: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (currentWindow.hwnd !== capture.hwnd || currentWindow.title !== capture.windowTitle) {
      return { ok: false, message: 'The window has changed since that capture — take a fresh look_at_screen before clicking.' }
    }

    if (!operateContext.hasUiaFailure(capture.hwnd, input.fallbackReason)) {
      // No UIA attempt is on record for this — check directly whether
      // something actionable is actually at this point before allowing a
      // guess. Only genuinely UIA-blind surfaces should ever reach here.
      try {
        const atPoint = await ctx.platform.operate.inspect({ at: { x: input.x, y: input.y } })
        if ('elements' in atPoint && atPoint.elements.length > 0 && atPoint.elements[0].patterns.length > 0) {
          return {
            ok: false,
            message: `"${atPoint.elements[0].name ?? atPoint.elements[0].role}" at that point is UI-Automation-actionable — use ui_act instead of a coordinate click.`
          }
        }
      } catch {
        // Couldn't check — fall through and allow it; the fingerprint check above already guarded staleness.
      }
    }

    try {
      await ctx.platform.operate.pointer({ x: input.x, y: input.y, action: input.action, scrollDelta: input.scrollDelta })
      return { ok: true, message: `Sent ${input.action} at (${input.x}, ${input.y}).` }
    } catch (err) {
      return { ok: false, message: `Pointer action failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  }
}

export const openSettingsPageTool: JarvisTool = {
  name: 'open_settings_page',
  description: 'Open a specific Windows Settings page directly — the structured, reliable way in (prefer this over navigating Settings by hand).',
  risk: 'safe',
  input: z.object({ page: z.enum(Object.keys(SETTINGS_PAGES) as [SettingsPageKey, ...SettingsPageKey[]]) }),
  run: async (input, ctx) => {
    const uri = settingsPageUri(input.page)
    return ctx.platform.openUrl(uri)
  }
}
