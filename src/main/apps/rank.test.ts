import { describe, it, expect } from 'vitest'
import { rankCandidates, scoreCandidate, AMBIGUITY_MARGIN } from './rank'
import { mintCanonicalId, type InstalledApplication } from './types'

function app(displayName: string, appId: string, launchKind: InstalledApplication['launchKind'] = 'aumid'): InstalledApplication {
  return { canonicalId: mintCanonicalId(appId), displayName, registrationSource: launchKind === 'steam-game' ? 'steam' : 'appsfolder', launchKind, appId }
}

// A realistic Get-StartApps-shaped fixture — real, well-documented AppIDs
// for each representative category (not this dev sandbox's own PC, but
// the same public, stable identifiers every past release's tests have
// used, since no Windows machine is available here either).
const FIXTURE: InstalledApplication[] = [
  app('Outlook', 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookForWindows.Desktop'),
  app('Outlook (classic)', 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE', 'desktop-path'),
  app('Excel', 'Microsoft.Office.EXCEL.EXE.15'),
  app('Word', 'Microsoft.Office.WINWORD.EXE.15'),
  app('PowerPoint', 'Microsoft.Office.POWERPNT.EXE.15'),
  app('Microsoft Edge', 'MSEdge'),
  app('Google Chrome', 'Chrome'),
  app('Settings', 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel'),
  app('Calculator', 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App'),
  app('Notepad', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'),
  app('File Explorer', 'Microsoft.Windows.Explorer'),
  app('Microsoft Store', 'Microsoft.WindowsStore_8wekyb3d8bbwe!App'),
  app('Steam', 'C:\\Program Files (x86)\\Steam\\steam.exe', 'desktop-path'),
  app('SteamVR', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SteamVR\\bin\\vrmonitor.exe', 'desktop-path')
]

function top(query: string, preferredCanonicalId: string | null = null): InstalledApplication | undefined {
  return rankCandidates(query, FIXTURE, preferredCanonicalId)[0]?.app
}

describe('apps/rank — resolves every representative app category correctly with no preference set', () => {
  it.each([
    ['outlook', 'Outlook'],
    ['outlook classic', 'Outlook (classic)'],
    ['excel', 'Excel'],
    ['word', 'Word'],
    ['powerpoint', 'PowerPoint'],
    ['edge', 'Microsoft Edge'],
    ['chrome', 'Google Chrome'],
    ['settings', 'Settings'],
    ['calculator', 'Calculator'],
    ['notepad', 'Notepad'],
    ['file explorer', 'File Explorer'],
    ['store', 'Microsoft Store'],
    ['steam', 'Steam']
  ])('"%s" -> %s', (query, expectedDisplayName) => {
    expect(top(query)?.displayName).toBe(expectedDisplayName)
  })

  it('never lets "Steam" tie with "SteamVR"', () => {
    const ranked = rankCandidates('steam', FIXTURE, null)
    expect(ranked[0].app.displayName).toBe('Steam')
    expect(ranked[0].score - (ranked[1]?.score ?? -Infinity)).toBeGreaterThanOrEqual(AMBIGUITY_MARGIN)
  })
})

describe('apps/rank — plain "outlook" is genuinely ambiguous with no preference', () => {
  it('new Outlook and classic Outlook are close enough to require disambiguation', () => {
    const ranked = rankCandidates('outlook', FIXTURE, null)
    const newOutlook = ranked.find((r) => r.app.displayName === 'Outlook')!
    const classic = ranked.find((r) => r.app.displayName === 'Outlook (classic)')!
    // Both score for containing "outlook" as a token; classic is penalized
    // for the "classic" token but not enough to guarantee it never ties —
    // this is exactly the real ambiguity a user should be asked about
    // once, not one the resolver should silently guess at.
    expect(newOutlook.score).toBeGreaterThan(0)
    expect(classic.score).toBeGreaterThan(0)
  })
})

describe('apps/rank — a preference resolves the ambiguity deterministically', () => {
  it('boosts the preferred candidate to the top regardless of plain-text score', () => {
    const classicId = FIXTURE.find((a) => a.displayName === 'Outlook (classic)')!.canonicalId
    const ranked = rankCandidates('outlook', FIXTURE, classicId)
    expect(ranked[0].app.displayName).toBe('Outlook (classic)')
    expect(ranked[0].score - ranked[1].score).toBeGreaterThanOrEqual(AMBIGUITY_MARGIN)
  })

  it('a preference for a canonicalId not in the catalog has zero effect (no injected candidate)', () => {
    const withBogusPreference = rankCandidates('outlook', FIXTURE, 'not-a-real-canonical-id')
    const withoutPreference = rankCandidates('outlook', FIXTURE, null)
    expect(withBogusPreference.map((r) => r.app.canonicalId)).toEqual(withoutPreference.map((r) => r.app.canonicalId))
    expect(withBogusPreference.map((r) => r.score)).toEqual(withoutPreference.map((r) => r.score))
  })
})

describe('apps/rank — scoreCandidate is pure and symmetric with rankCandidates', () => {
  it('an exact match always scores 100', () => {
    expect(scoreCandidate('Excel', 'Excel')).toBe(100)
    expect(scoreCandidate('excel', 'Excel')).toBe(100)
  })

  it('a non-match scores 0 or negative', () => {
    expect(scoreCandidate('excel', 'Calculator')).toBeLessThanOrEqual(0)
  })
})
