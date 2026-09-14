import { describe, it, expect, vi } from 'vitest'
import { launchAppByName, resolveAppByName, type LaunchAppDeps } from './launchApp'
import { mintCanonicalId, type InstalledApplication, type LaunchOutcome } from './types'

function app(displayName: string, appId: string, launchKind: InstalledApplication['launchKind'] = 'aumid'): InstalledApplication {
  return { canonicalId: mintCanonicalId(appId), displayName, registrationSource: launchKind === 'steam-game' ? 'steam' : 'appsfolder', launchKind, appId }
}

const NEW_OUTLOOK = app('Outlook', 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookForWindows.Desktop')
const CLASSIC_OUTLOOK = app('Outlook (classic)', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE', 'desktop-path')
const EXCEL = app('Excel', 'Microsoft.Office.EXCEL.EXE.15')
const CHROME = app('Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'desktop-path')
// A deliberately, exactly tied pair (both single-token overlap with "foo",
// no startsWith/exact-match win either way) — "outlook" itself no longer
// ties between new/classic (see rank.test.ts: it resolves unambiguously,
// which is the correct, desired behavior), so a real tie needs its own
// synthetic fixture rather than forcing one that doesn't actually occur.
const FOO_READER = app('Foo Reader', 'Foo.Reader_8wekyb3d8bbwe!App')
const FOO_EDITOR = app('Foo Editor', 'Foo.Editor_8wekyb3d8bbwe!App')
const CATALOG = [NEW_OUTLOOK, CLASSIC_OUTLOOK, EXCEL, CHROME, FOO_READER, FOO_EDITOR]

function deps(overrides: Partial<LaunchAppDeps> = {}): LaunchAppDeps {
  return {
    getCatalog: () => CATALOG,
    getPreference: () => null,
    launch: vi.fn().mockResolvedValue({ status: 'accepted', confidence: 'unverified' } satisfies LaunchOutcome),
    ...overrides
  }
}

describe('apps/launchApp launchAppByName', () => {
  it('reports "not installed" for a name matching nothing, without guessing', async () => {
    const launch = vi.fn()
    const result = await launchAppByName('some random app that does not exist', deps({ launch }))
    expect(result.ok).toBe(false)
    expect(result.trace.finalResult).toBe('not-installed')
    expect(launch).not.toHaveBeenCalled() // never attempts a launch for an unmatched name
  })

  it('asks about a genuine tie instead of guessing between two real apps', async () => {
    const launch = vi.fn()
    const result = await launchAppByName('foo', deps({ launch }))
    expect(result.ok).toBe(false)
    expect(result.trace.finalResult).toBe('ambiguous')
    expect(result.ambiguousCandidates?.map((c) => c.displayName)).toEqual(expect.arrayContaining(['Foo Reader', 'Foo Editor']))
    expect(launch).not.toHaveBeenCalled() // never launches a guess
  })

  it('a preference resolves the same ambiguous name deterministically, to the exact preferred app', async () => {
    const launch = vi.fn().mockResolvedValue({ status: 'accepted', confidence: 'unverified' } satisfies LaunchOutcome)
    const result = await launchAppByName('foo', deps({ getPreference: () => FOO_EDITOR.canonicalId, launch }))
    expect(result.trace.preference.status).toBe('applied')
    expect(result.trace.selected?.displayName).toBe('Foo Editor')
    expect(launch).toHaveBeenCalledWith(FOO_EDITOR)
  })

  it('ignores a preference pointing at an app no longer installed, and ranks normally instead', async () => {
    const result = await launchAppByName('excel', deps({ getPreference: () => 'some-uninstalled-app-id' }))
    expect(result.trace.preference.status).toBe('ignored-not-installed')
    expect(result.trace.selected?.displayName).toBe('Excel')
  })

  it('INVARIANT: no natural-language preference text can ever become the activation target', async () => {
    // Exactly the confirmed real-world regression: a preference saved as a
    // full sentence, not a real canonicalId. It matches nothing in the
    // catalog, so it's ignored — resolution falls back to ordinary
    // ranking (which resolves "outlook" unambiguously to new Outlook —
    // see rank.test.ts), and the launch call only ever receives the real
    // catalog record, never the sentence.
    const contaminated = 'new Outlook, not classic'
    const launch = vi.fn().mockResolvedValue({ status: 'accepted', confidence: 'unverified' } satisfies LaunchOutcome)
    const result = await launchAppByName('outlook', deps({ getPreference: () => contaminated, launch }))
    expect(result.trace.preference.status).toBe('ignored-not-installed')
    expect(result.trace.preference.canonicalId).toBe(contaminated) // shown in the trace for visibility, but never used
    expect(result.trace.selected?.displayName).toBe('Outlook')
    expect(result.trace.activationTarget).not.toContain(contaminated)
    expect(launch).toHaveBeenCalledTimes(1)
    expect(launch).toHaveBeenCalledWith(NEW_OUTLOOK) // the real catalog record — never the sentence
  })

  it('INVARIANT: activationTarget is always derived from the selected candidate\'s own canonicalId', async () => {
    const result = await launchAppByName('excel', deps())
    expect(result.trace.activationTarget).toBe(`shell:AppsFolder\\${EXCEL.canonicalId}`)
    expect(result.trace.selected?.canonicalId).toBe(EXCEL.canonicalId)

    const pathResult = await launchAppByName('chrome', deps())
    expect(pathResult.trace.activationTarget).toBe(CHROME.canonicalId)
  })

  it('reports "launched"/"confirmed" ok:true when a new process is observed', async () => {
    const outcome: LaunchOutcome = { status: 'launched', confidence: 'confirmed', evidence: { pid: 1234, processName: 'chrome' } }
    const result = await launchAppByName('chrome', deps({ launch: vi.fn().mockResolvedValue(outcome) }))
    expect(result.ok).toBe(true)
    expect(result.trace.finalResult).toBe('launched')
    expect(result.trace.confidence).toBe('confirmed')
    expect(result.trace.observed).toEqual({ pid: 1234, processName: 'chrome' })
    expect(result.message).toBe('Opened Google Chrome.')
  })

  it('reports "launched"/"existing-instance" as ok:true, not a failure (the Excel false-negative this replaces)', async () => {
    const outcome: LaunchOutcome = { status: 'launched', confidence: 'existing-instance', evidence: { pid: 999, processName: 'excel' } }
    const result = await launchAppByName('excel', deps({ launch: vi.fn().mockResolvedValue(outcome) }))
    expect(result.ok).toBe(true)
    expect(result.trace.confidence).toBe('existing-instance')
    expect(result.trace.finalResult).toBe('launched')
  })

  it('NEVER reports "accepted"/"unverified" as a failure — an accepted native launch must not be reported as failed', async () => {
    const outcome: LaunchOutcome = { status: 'accepted', confidence: 'unverified' }
    const result = await launchAppByName('excel', deps({ launch: vi.fn().mockResolvedValue(outcome) }))
    expect(result.ok).toBe(true)
    expect(result.trace.finalResult).toBe('accepted')
    expect(result.trace.confidence).toBe('unverified')
    expect(result.message).toBe('Opening Excel.')
    expect(result.message).not.toMatch(/fail|couldn't|error/i)
  })

  it('only reports "failed" when the native launch call itself reports a real error', async () => {
    const outcome: LaunchOutcome = { status: 'failed', error: 'The system cannot find the file specified.' }
    const result = await launchAppByName('excel', deps({ launch: vi.fn().mockResolvedValue(outcome) }))
    expect(result.ok).toBe(false)
    expect(result.trace.finalResult).toBe('failed')
    expect(result.trace.activationResult).toEqual({ error: 'The system cannot find the file specified.' })
  })

  it('resolveAppByName resolves without ever launching — backs the App Launch Lab\'s Resolve button', () => {
    const result = resolveAppByName('excel', { getCatalog: () => CATALOG, getPreference: () => null })
    expect(result.ok).toBe(true)
    expect(result.trace.selected?.displayName).toBe('Excel')
    expect(result.trace.activationTarget).toBe(`shell:AppsFolder\\${EXCEL.canonicalId}`)
    expect(result.trace.activationResult).toBeNull() // never attempted a launch
  })

  it('resolveAppByName still reports ambiguity/not-installed the same way as the real launch path', () => {
    const ambiguous = resolveAppByName('foo', { getCatalog: () => CATALOG, getPreference: () => null })
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.trace.finalResult).toBe('ambiguous')

    const notInstalled = resolveAppByName('nonexistent', { getCatalog: () => CATALOG, getPreference: () => null })
    expect(notInstalled.trace.finalResult).toBe('not-installed')
  })

  it('a steam-game candidate gets a Steam-protocol trace, independent of the AppsFolder path', async () => {
    const game = app('Half-Life 2', '220', 'steam-game')
    const result = await launchAppByName('half-life 2', {
      getCatalog: () => [game],
      getPreference: () => null,
      launch: vi.fn().mockResolvedValue({ status: 'accepted', confidence: 'unverified' } satisfies LaunchOutcome)
    })
    expect(result.trace.activationMethod).toBe('Steam protocol')
    expect(result.trace.activationTarget).toBe('steam://rungameid/220')
  })
})
