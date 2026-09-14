import { jarvisHelper } from './helper'
import type { OperateControl } from './types'
import type { ActionResult, ElementDetail, InspectResult, OperateTarget, WaitResult, WindowSummary } from '../operate/types'

/**
 * Thin adapter from OperateControl's typed methods onto jarvis-helper.exe's
 * JSON-RPC calls (Uia/*.cs) — every call includes `excludePids: [process.pid]`
 * so "the active window" never resolves to one of JARVIS's own Electron
 * windows just because Command Center happens to have focus (e.g. while
 * using the Operate Lab). See the plan's OperateContext design.
 */
export class WindowsOperateControl implements OperateControl {
  private excludePids(): number[] {
    return [process.pid]
  }

  async inspect(params: { window?: string; query?: string; ref?: string; at?: { x: number; y: number }; maxElements?: number }): Promise<InspectResult | ElementDetail> {
    const result = await jarvisHelper.uiInspect({ ...params, excludePids: this.excludePids() })
    return result as unknown as InspectResult | ElementDetail
  }

  async act(params: {
    target: OperateTarget
    action: string
    desiredState?: string
    value?: string
    option?: string
    direction?: string
    waitMs?: number
  }): Promise<ActionResult> {
    const result = await jarvisHelper.uiAct({ ...params, excludePids: this.excludePids() })
    return result as unknown as ActionResult
  }

  async wait(params: { condition: string; target?: OperateTarget; state?: string; titleContains?: string; timeoutMs: number }): Promise<WaitResult> {
    const result = await jarvisHelper.uiWait({ ...params, excludePids: this.excludePids() })
    return result as unknown as WaitResult
  }

  async fingerprint(): Promise<WindowSummary> {
    const result = await jarvisHelper.uiFingerprint(this.excludePids())
    return result as unknown as WindowSummary
  }

  async sendKeys(keys: string): Promise<void> {
    await jarvisHelper.inputKeys(keys)
  }

  async sendText(text: string): Promise<void> {
    await jarvisHelper.inputText(text)
  }

  async pointer(params: { x: number; y: number; action: string; button?: string; scrollDelta?: number }): Promise<void> {
    await jarvisHelper.inputPointer(params)
  }
}
