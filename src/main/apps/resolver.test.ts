import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppCatalogEntry } from './catalog'

let catalog: AppCatalogEntry[] = []
let aliases = new Map<string, string>()

vi.mock('./catalog', () => ({
  getCatalog: () => catalog
}))

vi.mock('../context', () => ({
  contextManager: {
    memory: {
      aliases: () => aliases
    }
  }
}))

// Imported after the mocks above so resolver.ts picks them up.
const { resolveApp, candidatesForLaunch } = await import('./resolver')

const NEW_OUTLOOK_AUMID = 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookForWindows.Desktop'

describe('apps/resolver — Outlook regression coverage', () => {
  beforeEach(() => {
    catalog = []
    aliases = new Map()
  })

  it('classifies an orphaned AUMID-shaped alias as "packaged", not "shortcut" (the confirmed real-PC regression)', () => {
    // The saved alias's target isn't in the current catalog snapshot at
    // all (catalog staleness/rename) — exactly the state that broke New
    // Outlook: the old code assumed this meant a safe exe/path and tried
    // to Start-Process an AUMID string.
    aliases.set('outlook', NEW_OUTLOOK_AUMID)
    const resolution = resolveApp('outlook')
    expect(resolution).not.toBeNull()
    expect(resolution && 'entry' in resolution && resolution.entry.kind).toBe('packaged')
    expect(resolution && 'entry' in resolution && resolution.entry.appId).toBe(NEW_OUTLOOK_AUMID)
  })

  it('classifies an orphaned plain-path alias as "shortcut", unaffected by the AUMID fix', () => {
    aliases.set('notepad', 'C:\\Windows\\notepad.exe')
    const resolution = resolveApp('notepad')
    expect(resolution && 'entry' in resolution && resolution.entry.kind).toBe('shortcut')
  })

  it('still returns the exact catalog entry when the alias target does match something current', () => {
    catalog = [{ displayName: 'New Outlook', kind: 'packaged', launchTarget: NEW_OUTLOOK_AUMID, appId: NEW_OUTLOOK_AUMID }]
    aliases.set('outlook', NEW_OUTLOOK_AUMID)
    const resolution = resolveApp('outlook')
    expect(resolution && 'entry' in resolution && resolution.entry.displayName).toBe('New Outlook')
  })
})

describe('apps/resolver — candidatesForLaunch', () => {
  beforeEach(() => {
    catalog = []
  })

  it('returns just the entry itself when nothing else shares its display name', () => {
    const entry: AppCatalogEntry = { displayName: 'Excel', kind: 'packaged', launchTarget: 'Microsoft.Office.EXCEL.EXE.15' }
    catalog = [entry]
    expect(candidatesForLaunch(entry)).toEqual([entry])
  })

  it('offers a same-name, different-target entry as a second candidate (e.g. Start Menu + App Paths)', () => {
    const startMenu: AppCatalogEntry = { displayName: 'Chrome', kind: 'shortcut', launchTarget: 'chrome-aumid-or-stale-path' }
    const appPaths: AppCatalogEntry = { displayName: 'Chrome', kind: 'shortcut', launchTarget: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
    catalog = [startMenu, appPaths]
    expect(candidatesForLaunch(startMenu)).toEqual([startMenu, appPaths])
  })

  it('never offers a different display name as a fallback candidate (no silent app substitution)', () => {
    const newOutlook: AppCatalogEntry = { displayName: 'Outlook', kind: 'packaged', launchTarget: NEW_OUTLOOK_AUMID }
    const classicOutlook: AppCatalogEntry = { displayName: 'Outlook (classic)', kind: 'shortcut', launchTarget: 'C:\\...\\OUTLOOK.EXE' }
    catalog = [newOutlook, classicOutlook]
    expect(candidatesForLaunch(newOutlook)).toEqual([newOutlook])
  })

  it('dedupes identical targets and caps at 3 candidates', () => {
    const entry: AppCatalogEntry = { displayName: 'Thing', kind: 'shortcut', launchTarget: 'a' }
    catalog = [
      entry,
      { displayName: 'Thing', kind: 'shortcut', launchTarget: 'a' }, // exact duplicate — dropped
      { displayName: 'Thing', kind: 'shortcut', launchTarget: 'b' },
      { displayName: 'Thing', kind: 'shortcut', launchTarget: 'c' },
      { displayName: 'Thing', kind: 'shortcut', launchTarget: 'd' }
    ]
    const result = candidatesForLaunch(entry)
    expect(result).toHaveLength(3)
    expect(result.map((c) => c.launchTarget)).toEqual(['a', 'b', 'c'])
  })
})
