import { resolveApp } from '../apps/resolver'

export interface LocalCommandMatch {
  toolName: string
  toolInput: Record<string, unknown>
  spoken: string
}

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
}

/**
 * Deterministic phrase → tool mapping for a small set of unambiguous voice
 * commands, so the common "mute", "volume to 40", "open Chrome" style of
 * request never pays for a Claude call at all — see the cost-aware-routing
 * priority. Deliberately narrow and conservative: every tool here is
 * 'safe' risk except open_app (which is 'moderate' but never blocks on
 * confirmation), and open_app only matches when resolveApp is confident
 * (a single, unambiguous hit) — anything murkier (no match, or a genuine
 * tie) returns null so Claude handles it normally, including the
 * ask-once-then-remember alias flow. A false negative here just costs one
 * ordinary Claude turn; a false positive would silently do the wrong
 * thing, so patterns are kept tight rather than clever.
 */
export function matchLocalCommand(rawText: string): LocalCommandMatch | null {
  const text = normalize(rawText)
  if (!text) return null

  if (/^mute( (the )?(volume|audio|sound))?$/.test(text)) {
    return { toolName: 'mute', toolInput: {}, spoken: 'Muted.' }
  }
  if (/^unmute( (the )?(volume|audio|sound))?$/.test(text)) {
    return { toolName: 'unmute', toolInput: {}, spoken: 'Unmuted.' }
  }

  const volumeSet = text.match(/^(?:set |turn )?(?:the )?volume (?:to |up to |down to )?(\d{1,3})\s*(?:%|percent)?$/)
  if (volumeSet) {
    const percent = Math.max(0, Math.min(100, parseInt(volumeSet[1], 10)))
    return { toolName: 'set_volume', toolInput: { percent }, spoken: `Volume set to ${percent} percent.` }
  }

  if (/^(turn (the )?)?volume up$/.test(text)) {
    return { toolName: 'volume_up', toolInput: {}, spoken: 'Turning the volume up.' }
  }
  if (/^(turn (the )?)?volume down$/.test(text)) {
    return { toolName: 'volume_down', toolInput: {}, spoken: 'Turning the volume down.' }
  }

  if (/^(take |grab )?(a )?screenshot$/.test(text)) {
    return { toolName: 'screenshot', toolInput: {}, spoken: 'Taking a screenshot.' }
  }

  if (/^run (a |the )?self[- ]?test$/.test(text)) {
    return { toolName: 'self_test', toolInput: {}, spoken: 'Running the self-test.' }
  }

  const openMatch = text.match(/^(?:open|launch|start)\s+(.+)$/)
  if (openMatch) {
    const name = openMatch[1].trim()
    if (!name) return null
    const resolution = resolveApp(name)
    if (resolution && !('ambiguous' in resolution)) {
      return { toolName: 'open_app', toolInput: { name }, spoken: `Opening ${resolution.entry.displayName}.` }
    }
    return null // no confident catalog match — let Claude's open_app tool (and its ambiguity/alias flow) handle it
  }

  return null
}
