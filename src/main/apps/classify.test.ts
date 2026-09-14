import { describe, it, expect } from 'vitest'
import { classifyAppKind } from './classify'

describe('apps/classify classifyAppKind', () => {
  it('classifies a real filesystem path as "shortcut" (Start-Process launch)', () => {
    expect(classifyAppKind(true)).toBe('shortcut')
  })

  it('classifies anything that is not a real path as "packaged" (shell:AppsFolder launch)', () => {
    // Covers both a true UWP AppUserModelID ("Family!App") and a
    // Click-to-Run-style Office AppID ("Microsoft.Office.EXCEL.EXE.15")
    // equally — isPath being false is what matters, not the AppID's shape.
    // The confirmed real bug this guards against classified the latter as
    // a path and tried to Start-Process a string that isn't one.
    expect(classifyAppKind(false)).toBe('packaged')
  })
})
