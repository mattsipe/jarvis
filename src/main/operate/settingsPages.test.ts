import { describe, it, expect } from 'vitest'
import { settingsPageUri, SETTINGS_PAGES } from './settingsPages'

describe('operate/settingsPages', () => {
  it('every allowlisted page maps to a real ms-settings: URI', () => {
    for (const key of Object.keys(SETTINGS_PAGES) as (keyof typeof SETTINGS_PAGES)[]) {
      expect(settingsPageUri(key)).toMatch(/^ms-settings:/)
    }
  })

  it('bluetooth resolves to the exact known page — the first validation target', () => {
    expect(settingsPageUri('bluetooth')).toBe('ms-settings:bluetooth')
  })

  it('the allowlist has no arbitrary/unexpected scheme', () => {
    for (const uri of Object.values(SETTINGS_PAGES)) {
      expect(uri.startsWith('ms-settings:')).toBe(true)
      expect(uri).not.toContain('http')
      expect(uri).not.toContain('..')
    }
  })
})
