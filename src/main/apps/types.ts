/**
 * Canonical installed-application identity, rebuilt from first principles
 * after a real-PC regression traced to the opposite design: a natural-
 * language preference ("Outlook means new Outlook, not classic") became a
 * literal launch target because there was no type boundary between "a
 * string Claude/memory produced" and "a real, currently-installed app's
 * launch identifier." See the plan's root-cause writeup.
 *
 * `CanonicalAppId` is a branded string — structurally still a string at
 * runtime (TypeScript has no true nominal typing), but the brand means
 * nothing can be assigned to it without an explicit, greppable cast. The
 * only place that cast should ever happen is apps/catalog.ts, when
 * building a record directly from what the OS/platform adapter actually
 * enumerated — never from memory, a preference, or free text.
 */
export type CanonicalAppId = string & { readonly __brand: unique symbol }

/** Only apps/catalog.ts should call this — see the type's doc comment. */
export function mintCanonicalId(raw: string): CanonicalAppId {
  return raw as CanonicalAppId
}

/**
 * Descriptive only — every kind here is launched the same way regardless
 * (see apps/launchApp.ts's activationMethod derivation and
 * platform/windows.ts's launchInstalledApp): a real filesystem path via
 * ShellExecute, or an AppsFolder parsing name (AUMID) via
 * `shell:AppsFolder\<id>` — Windows itself doesn't distinguish a true
 * UWP AppUserModelID from a Click-to-Run Office one, and neither does
 * this. 'steam-game' stays entirely on the pre-existing, untouched Steam
 * path (platform.launchSteamGame).
 */
export type LaunchKind = 'aumid' | 'desktop-path' | 'steam-game'

export interface InstalledApplication {
  /** The sole launch identity. Always equal to `appId` — kept as a distinct branded field so a raw string can never be passed where a resolved catalog record is required. */
  canonicalId: CanonicalAppId
  displayName: string
  registrationSource: 'appsfolder' | 'steam'
  launchKind: LaunchKind
  /** The raw AppID/AUMID/path/Steam-app-id string — identical to canonicalId, kept untyped for platform calls that still take plain strings (e.g. launchSteamGame). */
  appId: string
}

/**
 * What actually happened when a launch was attempted — deliberately
 * distinct from whether it could be *verified* (see the plan's "launch
 * result and launch observation/verification are separate concepts").
 * Only `failed` means `ok:false` to the caller; an accepted-but-unverified
 * native launch is never reported as a failure just because process
 * observation couldn't confirm it in time.
 */
export type LaunchOutcome =
  | { status: 'failed'; error: string }
  | { status: 'launched'; confidence: 'confirmed' | 'existing-instance'; evidence: { pid: number; processName: string } }
  | { status: 'accepted'; confidence: 'unverified' }

export interface LaunchTraceCandidate {
  displayName: string
  canonicalId: string
  launchKind: LaunchKind
  score: number
}

/**
 * One full record of a single open_app resolution+launch — logged
 * verbatim to jarvis.log and attached to the ToolResult's diagnostics, and
 * what the App Launch Lab's Resolve/Launch buttons render directly. Its
 * shape is the enforcement mechanism for "a phrase can never become an
 * activation target": `activationTarget` is only ever derived from
 * `selected.canonicalId` — see apps/launchApp.ts, and
 * launchApp.test.ts's invariant test.
 */
export interface LaunchTrace {
  request: string
  normalizedQuery: string
  preference: { query: string; canonicalId: string | null; status: 'applied' | 'none' | 'ignored-not-installed' }
  candidates: LaunchTraceCandidate[]
  selected: { displayName: string; canonicalId: string } | null
  registrationSource: string | null
  activationMethod: string | null
  activationTarget: string | null
  activationResult: 'ok' | { error: string } | null
  observed: { pid: number; processName: string } | null
  confidence: 'confirmed' | 'existing-instance' | 'unverified' | null
  finalResult: 'launched' | 'accepted' | 'failed' | 'ambiguous' | 'not-installed'
}
