import type { ActionResult } from './types'

const ACTION_VERBS: Record<string, string> = {
  invoke: 'Activated',
  toggle: 'Toggled',
  set_value: 'Set',
  select: 'Selected',
  expand: 'Expanded',
  collapse: 'Collapsed',
  focus: 'Focused',
  scroll: 'Scrolled'
}

/**
 * The single place that turns a native ActionResult into what Claude
 * actually sees — enforces, at the TS boundary too (defense in depth
 * alongside the C# side already keeping them distinct), that a
 * verification miss NEVER flips `ok` to false. Only `sent:false` (the
 * native call itself didn't go through, or the target couldn't be
 * resolved at all) does that. See the plan's "ACTION SENT distinct from
 * ACTION VERIFIED" requirement.
 */
export function deriveToolOutcome(result: ActionResult, action: string, targetLabel: string): { ok: boolean; message: string } {
  if (!result.sent) {
    const code = result.error?.code
    if (code === 'ambiguous_target') {
      const names = (result.candidates ?? []).map((c) => c.name ?? c.role ?? c.ref).join(', ')
      return { ok: false, message: `More than one match for ${targetLabel}: ${names}.` }
    }
    return { ok: false, message: `Couldn't act on ${targetLabel}: ${result.error?.message ?? 'unknown error'}.` }
  }

  const verb = ACTION_VERBS[action] ?? 'Acted on'
  if (result.noop) {
    return { ok: true, message: `${targetLabel} was already in the requested state.` }
  }

  switch (result.verification.status) {
    case 'verified':
      return { ok: true, message: `${verb} ${targetLabel} — verified (${result.verification.after ?? 'confirmed'}).` }
    case 'no_effect_observed':
      return { ok: true, message: `Sent ${action} to ${targetLabel} — no change observed yet (still ${result.verification.before ?? 'unknown'} after waiting).` }
    case 'not_verifiable':
      return { ok: true, message: `${verb} ${targetLabel} — can't verify this kind of action directly.` }
    default:
      return { ok: true, message: `Sent ${action} to ${targetLabel}.` }
  }
}
