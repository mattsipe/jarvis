import { z } from 'zod'
import type { JarvisTool, ToolResult } from './registry'

export const setVolumeTool: JarvisTool = {
  name: 'set_volume',
  description: 'Set the system output volume to an exact percentage (0-100).',
  risk: 'safe',
  input: z.object({ percent: z.number().min(0).max(100) }),
  run: (input, ctx) => ctx.platform.setVolume(input.percent)
}

export const volumeUpTool: JarvisTool = {
  name: 'volume_up',
  description: 'Increase the system output volume.',
  risk: 'safe',
  input: z.object({ step: z.number().min(1).max(50).default(10).describe('Percentage points to increase by.') }),
  run: (input, ctx) => ctx.platform.adjustVolume(input.step)
}

export const volumeDownTool: JarvisTool = {
  name: 'volume_down',
  description: 'Decrease the system output volume.',
  risk: 'safe',
  input: z.object({ step: z.number().min(1).max(50).default(10).describe('Percentage points to decrease by.') }),
  run: (input, ctx) => ctx.platform.adjustVolume(-input.step)
}

export const muteTool: JarvisTool = {
  name: 'mute',
  description: 'Mute system audio output.',
  risk: 'safe',
  input: z.object({}),
  run: (_input, ctx) => ctx.platform.setMute(true)
}

export const unmuteTool: JarvisTool = {
  name: 'unmute',
  description: 'Unmute system audio output.',
  risk: 'safe',
  input: z.object({}),
  run: (_input, ctx) => ctx.platform.setMute(false)
}

export const systemStatusTool: JarvisTool = {
  name: 'system_status',
  description: 'Get current system telemetry: CPU load, memory usage, uptime, battery.',
  risk: 'safe',
  input: z.object({}),
  run: async (_input, ctx): Promise<ToolResult> => {
    const status = await ctx.platform.getSystemStatus()
    const battery = status.batteryPct != null ? `, battery at ${Math.round(status.batteryPct)} percent` : ''
    return {
      ok: true,
      message: `${status.platform} host ${status.hostname}: CPU load ${status.cpuLoad1m.toFixed(2)}, memory ${status.memUsedPct.toFixed(0)} percent of ${status.memTotalGB.toFixed(0)} GB used, up ${Math.round(status.uptimeSec / 60)} minutes${battery}.`,
      data: status as unknown as Record<string, unknown>
    }
  }
}

export const screenshotTool: JarvisTool = {
  name: 'screenshot',
  description: 'Capture a screenshot of the primary display.',
  risk: 'safe',
  input: z.object({}),
  run: (_input, ctx) => ctx.platform.screenshot()
}

export const selfTestTool: JarvisTool = {
  name: 'self_test',
  description:
    'Run a built-in diagnostic self-test of this platform (PowerShell invocation, app enumeration, audio control, screenshot capability) with no lasting side effect. Use this to check whether desktop-control actions are working, without actually opening/changing anything for the user.',
  risk: 'safe',
  input: z.object({}),
  run: (_input, ctx) => ctx.platform.selfTest()
}
