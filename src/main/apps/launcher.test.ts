import { describe, it, expect, vi } from 'vitest'
import { launchWithFallback, makePlatformLauncher } from './launcher'
import type { AppCatalogEntry } from './catalog'
import type { PlatformControl, ToolResult } from '../platform/types'

function ok(message = 'Opened it.'): ToolResult {
  return { ok: true, message }
}
function fail(message = 'Failed.'): ToolResult {
  return { ok: false, message }
}

describe('apps/launcher launchWithFallback', () => {
  it('returns the first candidate\'s result when it succeeds, with no fallback used', async () => {
    const a: AppCatalogEntry = { displayName: 'A', kind: 'shortcut', launchTarget: 'a' }
    const b: AppCatalogEntry = { displayName: 'B', kind: 'shortcut', launchTarget: 'b' }
    const launch = vi.fn().mockResolvedValue(ok('Opened A.'))
    const outcome = await launchWithFallback([a, b], launch)
    expect(outcome.result.ok).toBe(true)
    expect(outcome.winningCandidate).toBe(a)
    expect(outcome.usedFallback).toBe(false)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('tries the next candidate when the first hard-fails, and reports usedFallback', async () => {
    const a: AppCatalogEntry = { displayName: 'A', kind: 'shortcut', launchTarget: 'a' }
    const b: AppCatalogEntry = { displayName: 'B', kind: 'packaged', launchTarget: 'b', appId: 'b' }
    const launch = vi
      .fn()
      .mockResolvedValueOnce(fail('Couldn\'t launch A: file not found.'))
      .mockResolvedValueOnce(ok('Opened B.'))
    const outcome = await launchWithFallback([a, b], launch)
    expect(outcome.result.ok).toBe(true)
    expect(outcome.result.message).toBe('Opened B.')
    expect(outcome.winningCandidate).toBe(b)
    expect(outcome.usedFallback).toBe(true)
    expect(launch).toHaveBeenCalledTimes(2)
  })

  it('accepts an unverified-but-ok result without trying the next candidate', async () => {
    const a: AppCatalogEntry = { displayName: 'A', kind: 'packaged', launchTarget: 'a', appId: 'a' }
    const b: AppCatalogEntry = { displayName: 'B', kind: 'shortcut', launchTarget: 'b' }
    const launch = vi.fn().mockResolvedValue(ok('Sent the command to open A, but no new window appeared yet — it may still be starting.'))
    const outcome = await launchWithFallback([a, b], launch)
    expect(outcome.result.ok).toBe(true)
    expect(outcome.winningCandidate).toBe(a)
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('returns the last failure when every candidate fails', async () => {
    const a: AppCatalogEntry = { displayName: 'A', kind: 'shortcut', launchTarget: 'a' }
    const b: AppCatalogEntry = { displayName: 'B', kind: 'shortcut', launchTarget: 'b' }
    const launch = vi.fn().mockResolvedValueOnce(fail('A: not found.')).mockResolvedValueOnce(fail('B: not found either.'))
    const outcome = await launchWithFallback([a, b], launch)
    expect(outcome.result.ok).toBe(false)
    expect(outcome.result.message).toBe('B: not found either.')
    expect(outcome.winningCandidate).toBeNull()
    expect(outcome.usedFallback).toBe(true)
  })

  it('fails cleanly with no candidates at all', async () => {
    const launch = vi.fn()
    const outcome = await launchWithFallback([], launch)
    expect(outcome.result.ok).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('apps/launcher makePlatformLauncher — dispatches to the right native mechanism per kind', () => {
  function fakePlatform(): PlatformControl {
    return {
      name: 'win32',
      openApp: vi.fn().mockResolvedValue(ok('opened via openApp')),
      closeApp: vi.fn(),
      openUrl: vi.fn(),
      setVolume: vi.fn(),
      adjustVolume: vi.fn(),
      setMute: vi.fn(),
      getSystemStatus: vi.fn(),
      screenshot: vi.fn(),
      findApp: vi.fn(),
      launchSteamGame: vi.fn().mockResolvedValue(ok('opened via steam')),
      focusWindow: vi.fn(),
      selfTest: vi.fn(),
      listInstalledApps: vi.fn(),
      launchByAppId: vi.fn().mockResolvedValue(ok('opened via aumid'))
    }
  }

  it('routes a packaged candidate (New Outlook, Excel, Calculator, Settings) through launchByAppId', async () => {
    const platform = fakePlatform()
    const launch = makePlatformLauncher(platform)
    const newOutlook: AppCatalogEntry = {
      displayName: 'Outlook',
      kind: 'packaged',
      launchTarget: 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookForWindows.Desktop',
      appId: 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookForWindows.Desktop'
    }
    const result = await launch(newOutlook)
    expect(platform.launchByAppId).toHaveBeenCalledWith(newOutlook.appId)
    expect(platform.openApp).not.toHaveBeenCalled()
    expect(result.message).toBe('opened via aumid')
  })

  // The representative app categories called out for regression coverage:
  // a Click-to-Run Office AppID (Excel, Word), and Windows' own built-in
  // packaged apps (Settings, Calculator) — all "packaged" per
  // apps/classify.ts's isPath-based classification, all activated the
  // same real way (IApplicationActivationManager via jarvis-helper.exe,
  // see AppLauncher.cs) regardless of which of those categories they are.
  it.each([
    ['Excel', 'Microsoft.Office.EXCEL.EXE.15'],
    ['Word', 'Microsoft.Office.WINWORD.EXE.15'],
    ['Settings', 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel'],
    ['Calculator', 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App']
  ])('routes %s through launchByAppId using its AppID', async (displayName, appId) => {
    const platform = fakePlatform()
    const launch = makePlatformLauncher(platform)
    const candidate: AppCatalogEntry = { displayName, kind: 'packaged', launchTarget: appId, appId }
    await launch(candidate)
    expect(platform.launchByAppId).toHaveBeenCalledWith(appId)
    expect(platform.openApp).not.toHaveBeenCalled()
  })

  it('routes an exe/shortcut candidate (Chrome, a normal Win32 exe) through openApp', async () => {
    const platform = fakePlatform()
    const launch = makePlatformLauncher(platform)
    const chrome: AppCatalogEntry = { displayName: 'Chrome', kind: 'shortcut', launchTarget: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
    await launch(chrome)
    expect(platform.openApp).toHaveBeenCalledWith(chrome.launchTarget)
    expect(platform.launchByAppId).not.toHaveBeenCalled()
  })

  it('routes a steam-game candidate through launchSteamGame', async () => {
    const platform = fakePlatform()
    const launch = makePlatformLauncher(platform)
    const game: AppCatalogEntry = { displayName: 'Some Game', kind: 'steam-game', launchTarget: '12345', appId: '12345' }
    await launch(game)
    expect(platform.launchSteamGame).toHaveBeenCalledWith('12345')
  })
})
