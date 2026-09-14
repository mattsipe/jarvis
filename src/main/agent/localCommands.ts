import { resolveApp } from '../apps/resolver'
import type { SettingsPageKey } from '../operate/settingsPages'

export interface LocalCommandMatch {
  toolName: string
  toolInput: Record<string, unknown>
  spoken: string
  /** For usage/turnLedger.ts diagnostics only — never read by dispatch logic. Defaults to 'local-command' when omitted. */
  source?: 'local-command' | 'instant' | 'settings-page' | 'operate-followup'
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
 * ask-once-then-set_app_preference flow. A false negative here just
 * costs one ordinary Claude turn; a false positive would silently do the
 * wrong thing, so patterns are kept tight rather than clever.
 */
/** A few common spoken names for each settings page — kept intentionally small; anything not listed here just falls through to Claude's own open_settings_page tool call. */
const SETTINGS_PAGE_ALIASES: Record<string, SettingsPageKey> = {
  bluetooth: 'bluetooth',
  wifi: 'wifi',
  'wi-fi': 'wifi',
  'wi fi': 'wifi',
  network: 'network',
  display: 'display',
  sound: 'sound',
  audio: 'sound',
  notifications: 'notifications',
  apps: 'apps',
  'default apps': 'default_apps',
  'windows update': 'windows_update',
  update: 'windows_update',
  personalization: 'personalization',
  power: 'power',
  storage: 'storage',
  mouse: 'mouse',
  keyboard: 'keyboard',
  privacy: 'privacy'
}

function formatTime(now: Date): string {
  return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDate(now: Date): string {
  return now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
}

export function matchLocalCommand(rawText: string, now: Date = new Date()): LocalCommandMatch | null {
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

  if (/^what(?:'s| is)( the)? time( is it)?$/.test(text) || text === 'what time is it') {
    return { toolName: 'noop', toolInput: {}, spoken: `It's ${formatTime(now)}.`, source: 'instant' }
  }
  if (/^what(?:'s| is)( the)?( today'?s)? date$|^what day is it$/.test(text)) {
    return { toolName: 'noop', toolInput: {}, spoken: `It's ${formatDate(now)}.`, source: 'instant' }
  }

  const settingsMatch = text.match(/^open (.+?) settings$/)
  if (settingsMatch) {
    const page = SETTINGS_PAGE_ALIASES[settingsMatch[1].trim()]
    if (page) {
      return { toolName: 'open_settings_page', toolInput: { page }, spoken: `Opening ${settingsMatch[1].trim()} settings.`, source: 'settings-page' }
    }
    return null // an unrecognized settings page name — let Claude's own open_settings_page tool call (or a normal answer) handle it
  }

  const openMatch = text.match(/^(?:open|launch|start)\s+(.+)$/)
  if (openMatch) {
    const name = openMatch[1].trim()
    if (!name) return null
    const resolution = resolveApp(name)
    if (resolution && !('ambiguous' in resolution)) {
      return { toolName: 'open_app', toolInput: { name }, spoken: `Opening ${resolution.entry.displayName}.` }
    }
    return null // no confident catalog match — let Claude's open_app tool (and its ambiguity/preference flow) handle it
  }

  return null
}

/**
 * "That's all" / "go back to sleep" / "end conversation" — the Presence
 * phase's spoken way to end a session, checked before anything else so it
 * costs nothing (no Claude call) and works whether or not wake-word
 * Presence is actually enabled (it's just a faster way to end than the
 * hotkey). A short "ok"/"okay"/"jarvis" filler prefix is tolerated since
 * that's how people actually say it; the three phrases themselves are
 * matched exactly, not fuzzily, so an unrelated sentence that happens to
 * contain one of these words never accidentally ends the conversation.
 */
export function matchEndPhrase(rawText: string): boolean {
  const text = normalize(rawText)
  if (!text) return false
  return /^(?:ok(?:ay)?[, ]+)?(?:jarvis[, ]+)?(?:that'?s all|go back to sleep|end conversation)$/.test(text)
}

/**
 * "Stop" / "cancel" / "never mind" — aborts whatever the current turn is
 * doing (a multi-step Operate task included), matched before anything
 * else so it costs nothing and works even mid-task. See
 * voice/session.ts's use of this alongside the existing barge-in/hotkey
 * abort paths — this is an additional phrase-based trigger, not a
 * replacement for either.
 */
export function matchStopPhrase(rawText: string): boolean {
  const text = normalize(rawText)
  if (!text) return false
  return /^(?:ok(?:ay)?[, ]+)?(?:jarvis[, ]+)?(?:stop|cancel|cancel that|never ?mind|abort|stop that|stop it)$/.test(text)
}
