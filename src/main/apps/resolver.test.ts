import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mintCanonicalId, type InstalledApplication } from './types'

let catalog: InstalledApplication[] = []

vi.mock('./catalog', () => ({
  getCatalog: () => catalog
}))

// Imported after the mock above so resolver.ts picks it up.
const { resolveApp } = await import('./resolver')

function app(displayName: string, appId: string, launchKind: InstalledApplication['launchKind'] = 'aumid'): InstalledApplication {
  return { canonicalId: mintCanonicalId(appId), displayName, registrationSource: 'appsfolder', launchKind, appId }
}

describe('apps/resolver — thin confidence check over the real catalog, no memory involved', () => {
  beforeEach(() => {
    catalog = []
  })

  it('returns null when the catalog is empty', () => {
    expect(resolveApp('outlook')).toBeNull()
  })

  it('resolves an unambiguous name to the real catalog entry', () => {
    catalog = [app('Excel', 'Microsoft.Office.EXCEL.EXE.15')]
    const resolution = resolveApp('excel')
    expect(resolution && 'entry' in resolution && resolution.entry.canonicalId).toBe('Microsoft.Office.EXCEL.EXE.15')
  })

  it('returns ambiguous candidates for a genuine tie, never guessing', () => {
    catalog = [app('Foo Reader', 'Foo.Reader!App'), app('Foo Editor', 'Foo.Editor!App')]
    const resolution = resolveApp('foo')
    expect(resolution && 'ambiguous' in resolution).toBe(true)
  })

  it('has no concept of memory/aliases at all — an identically-named non-catalog string never resolves to anything', () => {
    // There is no alias/memory lookup left in this module at all — the
    // confirmed real-PC regression this was rebuilt to fix required
    // exactly that lookup existing. A name not in the catalog is just
    // unresolved, full stop.
    catalog = [app('Outlook', 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!App')]
    expect(resolveApp('new Outlook, not classic')).toBeNull()
  })
})
