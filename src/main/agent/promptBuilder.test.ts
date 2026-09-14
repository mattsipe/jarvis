import { describe, it, expect } from 'vitest'
import { buildSystemBlocks, buildTurnContextLine, selectToolset, wantsCursorContext } from './promptBuilder'

describe('agent/promptBuilder buildSystemBlocks', () => {
  it('always includes the persona block with a cache breakpoint', () => {
    const blocks = buildSystemBlocks('', '')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' })
  })

  it('adds a second breakpointed block when memory or summary is present', () => {
    const blocks = buildSystemBlocks('What I remember: likes dark mode.', '')
    expect(blocks).toHaveLength(2)
    expect(blocks[1].cache_control).toEqual({ type: 'ephemeral' })
    expect(blocks[1].text).toContain('likes dark mode')
  })

  it('folds the session summary into the same second block, not a third', () => {
    const blocks = buildSystemBlocks('memory here', 'summary here')
    expect(blocks).toHaveLength(2)
    expect(blocks[1].text).toContain('memory here')
    expect(blocks[1].text).toContain('summary here')
  })

  it('is byte-identical across two calls with the same inputs (cache stability)', () => {
    const a = buildSystemBlocks('mem', 'sum')
    const b = buildSystemBlocks('mem', 'sum')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('agent/promptBuilder buildTurnContextLine', () => {
  it('never includes cursor when includeCursor is false, even if cursor is given', () => {
    const line = buildTurnContextLine({ nowIso: '2026-01-01T12:00:00.000Z', timeZone: 'UTC', includeCursor: false, cursor: { x: 1, y: 2 } })
    expect(line).not.toContain('Cursor')
  })

  it('includes cursor when includeCursor is true and cursor is given', () => {
    const line = buildTurnContextLine({ nowIso: '2026-01-01T12:00:00.000Z', timeZone: 'UTC', includeCursor: true, cursor: { x: 5, y: 9 } })
    expect(line).toContain('Cursor at (5, 9)')
  })

  it('includes the active window when given', () => {
    const line = buildTurnContextLine({ nowIso: '2026-01-01T12:00:00.000Z', timeZone: 'UTC', includeCursor: false, activeWindowTitle: 'Settings', activeProcess: 'SystemSettings.exe' })
    expect(line).toContain('"Settings"')
    expect(line).toContain('SystemSettings.exe')
  })

  it('includes a plan line when given', () => {
    const line = buildTurnContextLine({ nowIso: '2026-01-01T12:00:00.000Z', timeZone: 'UTC', includeCursor: false, planText: '1) open Settings 2) toggle Bluetooth' })
    expect(line).toContain('Plan: 1) open Settings')
  })

  it('truncates the ISO time to minute precision', () => {
    const line = buildTurnContextLine({ nowIso: '2026-01-01T12:34:56.789Z', timeZone: 'UTC', includeCursor: false })
    expect(line).toContain('2026-01-01 12:34')
    expect(line).not.toContain(':56')
  })
})

describe('agent/promptBuilder selectToolset', () => {
  it('gives fast the core-only toolset', () => {
    expect(selectToolset('fast')).toBe('core')
  })

  it('gives standard/deep/deep-plan the full toolset', () => {
    expect(selectToolset('standard')).toBe('core+operate')
    expect(selectToolset('deep')).toBe('core+operate')
    expect(selectToolset('deep-plan')).toBe('core+operate')
  })
})

describe('agent/promptBuilder wantsCursorContext', () => {
  it('detects pointer-related phrasing', () => {
    expect(wantsCursorContext('click that')).toBe(true)
    expect(wantsCursorContext('what is under my cursor')).toBe(true)
  })

  it('is false for unrelated phrasing', () => {
    expect(wantsCursorContext('open chrome')).toBe(false)
  })
})
