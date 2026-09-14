import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uiActTool, pointerActTool } from './operate'
import { resolveRisk } from './registry'
import { operateContext } from '../operate/context'
import type { OperateControl } from '../platform/types'
import type { ActionResult, WindowSummary } from '../operate/types'

function fakeOperate(overrides: Partial<OperateControl> = {}): OperateControl {
  return {
    inspect: vi.fn().mockResolvedValue({ elements: [], window: { hwnd: 0, title: null, processName: null }, truncated: false }),
    act: vi.fn(),
    wait: vi.fn(),
    fingerprint: vi.fn(),
    sendKeys: vi.fn(),
    sendText: vi.fn(),
    pointer: vi.fn(),
    ...overrides
  }
}

function fakeCtx(operate: OperateControl) {
  return { platform: { operate } as unknown as { operate: OperateControl }, context: {} as never } as never
}

describe('tools/operate ui_act', () => {
  beforeEach(() => {
    operateContext.reset()
  })

  it('an ambiguous result is relayed as ok:false with real candidates, and nothing is recorded as the last target', async () => {
    const result: ActionResult = {
      sent: false,
      error: { code: 'ambiguous_target', message: 'Ambiguous target.' },
      candidates: [
        { ref: 'e1', role: 'Button', name: 'OK', automationId: null, enabled: true, state: null, patterns: [] },
        { ref: 'e2', role: 'Button', name: 'OK', automationId: null, enabled: true, state: null, patterns: [] }
      ],
      verification: { status: 'pending' }
    }
    const operate = fakeOperate({ act: vi.fn().mockResolvedValue(result) })
    const outcome = await uiActTool.run({ target: { name: 'OK' }, action: 'invoke', intent: 'click OK' }, fakeCtx(operate))
    expect(outcome.ok).toBe(false)
    expect(outcome.data).toMatchObject({ ambiguous: true })
    expect(operateContext.getLastTarget()).toBeNull()
  })

  it('a stale_ref result is relayed as a clean ok:false failure', async () => {
    const result: ActionResult = { sent: false, error: { code: 'stale_ref', message: "Element ref 'e17' is stale or unknown." }, verification: { status: 'pending' } }
    const operate = fakeOperate({ act: vi.fn().mockResolvedValue(result) })
    const outcome = await uiActTool.run({ target: { ref: 'e17' }, action: 'toggle', desiredState: 'off', intent: 'turn it off' }, fakeCtx(operate))
    expect(outcome.ok).toBe(false)
    expect(operateContext.getLastTarget()).toBeNull()
  })

  it('a successful, verified toggle records the target for a later "turn it back off"', async () => {
    const result: ActionResult = {
      sent: true,
      sentVia: 'uia:Toggle',
      element: { ref: 'e17', role: 'ToggleSwitch', name: 'Bluetooth', automationId: null, enabled: true, state: 'On', patterns: ['Toggle'] },
      window: { hwnd: 42, title: 'Settings', processName: 'SystemSettings' },
      verification: { status: 'verified', before: 'Off', after: 'On' }
    }
    const operate = fakeOperate({ act: vi.fn().mockResolvedValue(result) })
    const outcome = await uiActTool.run({ target: { name: 'Bluetooth' }, action: 'toggle', desiredState: 'on', intent: 'turn on Bluetooth' }, fakeCtx(operate))
    expect(outcome.ok).toBe(true)
    const lastTarget = operateContext.getLastTarget()
    expect(lastTarget?.ref).toBe('e17')
    expect(lastTarget?.lastVerifiedState).toBe('On')
  })

  it('a not_actionable failure is recorded as a UIA failure for that window+target (justifies later pointer fallback)', async () => {
    const result: ActionResult = {
      sent: false,
      error: { code: 'not_actionable', message: "Element doesn't support Invoke." },
      element: { ref: 'e5', role: 'Custom', name: 'Canvas', automationId: null, enabled: true, state: null, patterns: [] },
      window: { hwnd: 99, title: 'Paint', processName: 'mspaint' },
      verification: { status: 'pending' }
    }
    const operate = fakeOperate({ act: vi.fn().mockResolvedValue(result) })
    await uiActTool.run({ target: { name: 'Canvas' }, action: 'invoke', intent: 'draw on the canvas' }, fakeCtx(operate))
    expect(operateContext.hasUiaFailure(99, '"Canvas" (Custom)')).toBe(true)
  })
})

describe('tools/operate risk escalation', () => {
  it('ui_act escalates to elevated for a consequential intent', () => {
    expect(resolveRisk(uiActTool, { target: { name: 'Send' }, action: 'invoke', intent: 'send the email' })).toBe('elevated')
  })

  it('ui_act stays moderate for a routine intent', () => {
    expect(resolveRisk(uiActTool, { target: { name: 'Bluetooth' }, action: 'toggle', intent: 'turn on Bluetooth' })).toBe('moderate')
  })
})

describe('tools/operate pointer_act — the fallback gate', () => {
  beforeEach(() => {
    operateContext.reset()
  })

  it('rejects when the capture is missing entirely', async () => {
    const operate = fakeOperate()
    const outcome = await pointerActTool.run(
      { captureId: 'nonexistent', x: 10, y: 10, action: 'click', fallbackReason: 'no UIA element', intent: 'click it' },
      fakeCtx(operate)
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/stale|fresh/i)
    expect(operate.pointer).not.toHaveBeenCalled()
  })

  it('rejects when the window has moved/changed since the capture', async () => {
    operateContext.recordCapture({ captureId: 'c1', hwnd: 42, windowTitle: 'Paint', capturedAt: Date.now(), region: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })
    const differentWindow: WindowSummary = { hwnd: 43, title: 'Notepad', processName: 'notepad' }
    const operate = fakeOperate({ fingerprint: vi.fn().mockResolvedValue(differentWindow) })
    const outcome = await pointerActTool.run(
      { captureId: 'c1', x: 10, y: 10, action: 'click', fallbackReason: 'no UIA element', intent: 'click it' },
      fakeCtx(operate)
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/changed/i)
    expect(operate.pointer).not.toHaveBeenCalled()
  })

  it('rejects when no prior UIA failure is on record AND something actionable is at that point', async () => {
    operateContext.recordCapture({ captureId: 'c1', hwnd: 42, windowTitle: 'Settings', capturedAt: Date.now(), region: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })
    const sameWindow: WindowSummary = { hwnd: 42, title: 'Settings', processName: 'SystemSettings' }
    const operate = fakeOperate({
      fingerprint: vi.fn().mockResolvedValue(sameWindow),
      inspect: vi.fn().mockResolvedValue({
        elements: [{ ref: 'e9', role: 'ToggleSwitch', name: 'Bluetooth', automationId: null, enabled: true, state: 'Off', patterns: ['Toggle'] }],
        window: sameWindow,
        truncated: false
      })
    })
    const outcome = await pointerActTool.run(
      { captureId: 'c1', x: 10, y: 10, action: 'click', fallbackReason: 'thought UIA could not do this', intent: 'toggle bluetooth' },
      fakeCtx(operate)
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/ui_act/i)
    expect(operate.pointer).not.toHaveBeenCalled()
  })

  it('allows the click when a prior UIA failure is on record for this window/reason', async () => {
    operateContext.recordCapture({ captureId: 'c1', hwnd: 42, windowTitle: 'Paint', capturedAt: Date.now(), region: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })
    operateContext.recordUiaFailure(42, 'the drawing canvas')
    const sameWindow: WindowSummary = { hwnd: 42, title: 'Paint', processName: 'mspaint' }
    const operate = fakeOperate({ fingerprint: vi.fn().mockResolvedValue(sameWindow) })
    const outcome = await pointerActTool.run(
      { captureId: 'c1', x: 10, y: 10, action: 'click', fallbackReason: 'the drawing canvas', intent: 'draw a line' },
      fakeCtx(operate)
    )
    expect(outcome.ok).toBe(true)
    expect(operate.pointer).toHaveBeenCalledWith({ x: 10, y: 10, action: 'click', scrollDelta: undefined })
  })

  it('allows the click when nothing actionable is found at that point, even with no prior recorded failure', async () => {
    operateContext.recordCapture({ captureId: 'c1', hwnd: 42, windowTitle: 'Paint', capturedAt: Date.now(), region: { x: 0, y: 0, width: 100, height: 100 }, scale: 1 })
    const sameWindow: WindowSummary = { hwnd: 42, title: 'Paint', processName: 'mspaint' }
    const operate = fakeOperate({
      fingerprint: vi.fn().mockResolvedValue(sameWindow),
      inspect: vi.fn().mockResolvedValue({ elements: [], window: sameWindow, truncated: false })
    })
    const outcome = await pointerActTool.run(
      { captureId: 'c1', x: 10, y: 10, action: 'click', fallbackReason: 'custom-drawn canvas, no UIA tree', intent: 'draw a line' },
      fakeCtx(operate)
    )
    expect(outcome.ok).toBe(true)
    expect(operate.pointer).toHaveBeenCalled()
  })
})
