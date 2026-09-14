import { describe, it, expect } from 'vitest'
import { OperateContext } from './context'

describe('operate/context OperateContext — lastTarget (powers "turn it back off")', () => {
  it('returns null when nothing has been recorded', () => {
    const ctx = new OperateContext(() => 1000)
    expect(ctx.getLastTarget()).toBeNull()
  })

  it('returns the recorded target while fresh', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordTarget({ ref: 'e17', name: 'Bluetooth', role: 'ToggleSwitch', window: 'Settings', lastAction: 'toggle', lastVerifiedState: 'On' })
    expect(ctx.getLastTarget()).toMatchObject({ ref: 'e17', name: 'Bluetooth' })
  })

  it('expires the target after 5 minutes', () => {
    let now = 1000
    const ctx = new OperateContext(() => now)
    ctx.recordTarget({ ref: 'e17', name: 'Bluetooth', role: 'ToggleSwitch', window: 'Settings', lastAction: 'toggle', lastVerifiedState: 'On' })
    now += 5 * 60 * 1000 + 1
    expect(ctx.getLastTarget()).toBeNull()
  })

  it('a newer target replaces the old one', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordTarget({ ref: 'e17', name: 'Bluetooth', role: 'ToggleSwitch', window: 'Settings', lastAction: 'toggle', lastVerifiedState: 'On' })
    ctx.recordTarget({ ref: 'e18', name: 'Wi-Fi', role: 'ToggleSwitch', window: 'Settings', lastAction: 'toggle', lastVerifiedState: 'Off' })
    expect(ctx.getLastTarget()?.ref).toBe('e18')
  })
})

describe('operate/context OperateContext — captures (powers pointer_act freshness)', () => {
  it('a capture is fresh immediately after recording', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordCapture({ captureId: 'c1', hwnd: 42, windowTitle: 'Paint', capturedAt: 1000, region: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })
    expect(ctx.isCaptureFresh('c1')).toBe(true)
  })

  it('a capture older than 10s is not fresh', () => {
    let now = 1000
    const ctx = new OperateContext(() => now)
    ctx.recordCapture({ captureId: 'c1', hwnd: 42, windowTitle: 'Paint', capturedAt: 1000, region: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })
    now += 10_001
    expect(ctx.isCaptureFresh('c1')).toBe(false)
  })

  it('an unknown captureId is never fresh', () => {
    const ctx = new OperateContext(() => 1000)
    expect(ctx.isCaptureFresh('nonexistent')).toBe(false)
  })

  it('only the newest 2 captures are kept', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordCapture({ captureId: 'c1', hwnd: 1, windowTitle: null, capturedAt: 1000, region: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 })
    ctx.recordCapture({ captureId: 'c2', hwnd: 1, windowTitle: null, capturedAt: 1000, region: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 })
    ctx.recordCapture({ captureId: 'c3', hwnd: 1, windowTitle: null, capturedAt: 1000, region: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 })
    expect(ctx.getCapture('c1')).toBeNull()
    expect(ctx.getCapture('c2')).not.toBeNull()
    expect(ctx.getCapture('c3')).not.toBeNull()
  })
})

describe('operate/context OperateContext — UIA failure tracking (justifies pointer fallback)', () => {
  it('reports no failure before one is recorded', () => {
    const ctx = new OperateContext(() => 1000)
    expect(ctx.hasUiaFailure(42, 'canvas')).toBe(false)
  })

  it('reports a failure after one is recorded, for that exact window+description', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordUiaFailure(42, 'the drawing canvas')
    expect(ctx.hasUiaFailure(42, 'the drawing canvas')).toBe(true)
    expect(ctx.hasUiaFailure(42, 'THE DRAWING CANVAS')).toBe(true) // case-insensitive
  })

  it('a failure recorded for a different window does not count', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordUiaFailure(42, 'canvas')
    expect(ctx.hasUiaFailure(99, 'canvas')).toBe(false)
  })
})

describe('operate/context OperateContext — window tracking and reset', () => {
  it('recordExternalWindow / getLastExternalWindow round-trips, and skips nothing itself (caller is responsible for excluding JARVIS)', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordExternalWindow({ hwnd: 7, pid: 123, title: 'Settings', process: 'SystemSettings' })
    expect(ctx.getLastExternalWindow()).toEqual({ hwnd: 7, pid: 123, title: 'Settings', process: 'SystemSettings' })
  })

  it('reset() clears everything', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordExternalWindow({ hwnd: 7, pid: 123, title: 'Settings', process: 'SystemSettings' })
    ctx.recordTarget({ ref: 'e17', name: 'Bluetooth', role: 'ToggleSwitch', window: 'Settings', lastAction: 'toggle', lastVerifiedState: 'On' })
    ctx.recordCapture({ captureId: 'c1', hwnd: 1, windowTitle: null, capturedAt: 1000, region: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 })
    ctx.recordUiaFailure(1, 'x')
    ctx.reset()
    expect(ctx.getLastExternalWindow()).toBeNull()
    expect(ctx.getLastTarget()).toBeNull()
    expect(ctx.getCapture('c1')).toBeNull()
    expect(ctx.hasUiaFailure(1, 'x')).toBe(false)
  })
})

describe('operate/context OperateContext — summary()', () => {
  it('is empty with nothing recorded', () => {
    const ctx = new OperateContext(() => 1000)
    expect(ctx.summary()).toBe('')
  })

  it('includes the last target and last external window, staying under 300 chars', () => {
    const ctx = new OperateContext(() => 1000)
    ctx.recordTarget({ ref: 'e17', name: 'Bluetooth', role: 'ToggleSwitch', window: 'Settings', lastAction: 'toggle', lastVerifiedState: 'On' })
    ctx.recordExternalWindow({ hwnd: 7, pid: 123, title: 'Settings', process: 'SystemSettings' })
    const summary = ctx.summary()
    expect(summary).toContain('e17')
    expect(summary).toContain('Bluetooth')
    expect(summary).toContain('Settings')
    expect(summary.length).toBeLessThanOrEqual(300)
  })
})
