import type { RiskLevel } from '../tools/registry'

export interface RiskContext {
  intent: string
  targetName?: string | null
  targetRole?: string | null
  targetAutomationId?: string | null
  windowTitle?: string | null
  processName?: string | null
  keys?: string | null
}

/**
 * Consequential-action detection for Operate tools — see the plan's risk
 * gating design. Deliberately conservative: anything that plausibly sends,
 * pays, deletes, or discards work escalates to 'elevated' (confirmation
 * required) even at the cost of an occasional unnecessary confirmation,
 * since the alternative (a missed elevation) is a real-world consequence.
 */
const ELEVATED_WORDS =
  /\b(send|submit|post|publish|reply all|forward|pay|purchase|buy|checkout|order|delete|remove|erase|wipe|discard|don'?t save|do not save|uninstall|reset|factory|format|sign out|log ?out|change password|remove account|disable\b[\s\w]*\b(firewall|defender|bitlocker|security)|shut ?down|restart|sleep)\b/i

const UNSAVED_MARKER = /\*|unsaved/i

export function classifyRisk(ctx: RiskContext): { risk: RiskLevel; reason: string } {
  // Deliberately excludes windowTitle: being *inside* a window named
  // "Checkout" or "Compose" isn't itself consequential (e.g. clicking
  // "Cancel" there) — only what's actually being done (intent/target
  // name) counts here. A consequential *window* only matters combined
  // with an unlabeled icon button, handled separately below.
  const haystack = [ctx.intent, ctx.targetName].filter(Boolean).join(' ')
  if (ELEVATED_WORDS.test(haystack)) {
    return { risk: 'elevated', reason: 'Intent or target matches a consequential action word.' }
  }

  if (ctx.keys) {
    const chord = ctx.keys.toLowerCase()
    const inComposeOrMail = /compose|mail|outlook/i.test(ctx.windowTitle ?? '') || /compose|mail|outlook/i.test(ctx.processName ?? '')
    if ((chord === 'ctrl+enter' || chord === 'alt+s') && inComposeOrMail) {
      return { risk: 'elevated', reason: 'Send shortcut in a mail/compose window.' }
    }
    if (chord === 'shift+delete') {
      return { risk: 'elevated', reason: 'Shift+Delete permanently deletes, bypassing the Recycle Bin.' }
    }
    if (chord === 'alt+f4' && UNSAVED_MARKER.test(ctx.windowTitle ?? '')) {
      return { risk: 'elevated', reason: 'Closing a window with unsaved changes.' }
    }
  }

  // An icon-only (unlabeled) invoke inside a mail compose / checkout / form
  // window defaults to confirm — the risk of misreading an icon button in
  // exactly these contexts (Send, Place Order, Submit) is high enough that
  // "ask" is the safer default even without a name to match against.
  const inConsequentialWindow = /compose|checkout|payment|order/i.test(ctx.windowTitle ?? '')
  const isUnlabeledInvoke = !ctx.targetName && (ctx.targetRole === 'Button' || ctx.targetRole === 'SplitButton')
  if (inConsequentialWindow && isUnlabeledInvoke) {
    return { risk: 'elevated', reason: 'Unlabeled button inside a compose/checkout/order window.' }
  }

  return { risk: 'moderate', reason: 'Routine, reversible interaction.' }
}
