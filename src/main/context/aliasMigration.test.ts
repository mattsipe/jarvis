import { describe, it, expect } from 'vitest'
import { matchLegacyAliasToApp } from './aliasMigration'

const CATALOG = [
  { canonicalId: 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!App', displayName: 'Outlook' },
  { canonicalId: 'Microsoft.Office.EXCEL.EXE.15', displayName: 'Excel' }
]

describe('context/aliasMigration matchLegacyAliasToApp', () => {
  it('matches an alias whose content is exactly a real canonicalId', () => {
    const result = matchLegacyAliasToApp({ subject: 'outlook', content: 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!App' }, CATALOG)
    expect(result).toBe('Microsoft.OutlookForWindows_8wekyb3d8bbwe!App')
  })

  it('matches an alias whose content is exactly a real display name (case-insensitive)', () => {
    expect(matchLegacyAliasToApp({ subject: 'excel', content: 'excel' }, CATALOG)).toBe('Microsoft.Office.EXCEL.EXE.15')
  })

  it('returns null for free-text content — the confirmed real-world regression shape', () => {
    // This is the exact real-PC contamination: a saved "alias" whose
    // content was a whole sentence, not an app identifier at all.
    const result = matchLegacyAliasToApp({ subject: 'outlook', content: 'new Outlook, not classic' }, CATALOG)
    expect(result).toBeNull()
  })

  it('returns null when the catalog is empty (nothing to match against, migrate safely to inert text)', () => {
    expect(matchLegacyAliasToApp({ subject: 'outlook', content: 'Outlook' }, [])).toBeNull()
  })

  it('never partial/fuzzy matches — only an exact id or exact display name counts', () => {
    expect(matchLegacyAliasToApp({ subject: 'outlook', content: 'Outlook (new)' }, CATALOG)).toBeNull()
    expect(matchLegacyAliasToApp({ subject: 'outlook', content: 'Microsoft.OutlookForWindows' }, CATALOG)).toBeNull()
  })
})
