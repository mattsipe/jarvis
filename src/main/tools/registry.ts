import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type Anthropic from '@anthropic-ai/sdk'
import type { PlatformControl, ToolResult } from '../platform/types'
import type { ContextManager } from '../context'
import { logInfo, logError } from '../logger'

export type { ToolResult } from '../platform/types'

/**
 * safe — runs immediately.
 * moderate — runs immediately but is announced (Claude narrates it in the
 *   same turn, before/while the tool executes — see agent/loop.ts) and
 *   logged to recent actions.
 * elevated — blocks on explicit HUD/voice confirmation before running.
 * No risk level below elevated ever skips execution; no risk level runs
 * an unrestricted/raw shell command — that's a hard constraint, not a
 * default (see the plan's ToolRegistry section).
 */
export type RiskLevel = 'safe' | 'moderate' | 'elevated'

export interface ToolContext {
  platform: PlatformControl
  context: ContextManager
}

export interface JarvisTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string
  description: string
  input: S
  /**
   * Most tools declare a fixed level. Operate's tools (tools/operate.ts)
   * instead pass a function, since the very same tool (ui_act, say) is
   * routine for a Bluetooth toggle and consequential for "Send" — see
   * operate/risk.ts's classifyRisk(). Always resolve this through
   * resolveRisk() below, never read `.risk` directly.
   */
  risk: RiskLevel | ((input: z.infer<S>) => RiskLevel)
  /**
   * Toolset membership for the optimized engine's cost-aware routing (see
   * agent/promptBuilder.ts's selectToolset) — 'operate' for the six
   * UIA/keyboard/pointer tools, defaulting to 'core' for everything else.
   * Purely additive metadata: never read by the legacy engine or by
   * ToolRegistry.execute, so it changes no tool's behavior.
   */
  group?: 'core' | 'operate'
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
}

/** The one place a tool's risk is actually decided for a given call — see JarvisTool.risk's doc comment. */
export function resolveRisk(tool: JarvisTool, input: unknown): RiskLevel {
  return typeof tool.risk === 'function' ? tool.risk(input) : tool.risk
}

class ToolRegistry {
  private tools = new Map<string, JarvisTool>()

  register<S extends z.ZodTypeAny>(tool: JarvisTool<S>): void {
    this.tools.set(tool.name, tool as unknown as JarvisTool)
  }

  get(name: string): JarvisTool | undefined {
    return this.tools.get(name)
  }

  list(): JarvisTool[] {
    return [...this.tools.values()]
  }

  /**
   * Converts registered tools into Claude's tool-use format. `toolset`
   * (optimized engine only — see agent/promptBuilder.ts) restricts this
   * to non-Operate tools when 'core'; omitted or 'core+operate' returns
   * everything, matching the legacy engine's unfiltered behavior exactly.
   */
  toAnthropicTools(toolset: 'core' | 'core+operate' = 'core+operate'): Anthropic.Tool[] {
    return this.list()
      .filter((tool) => toolset === 'core+operate' || (tool.group ?? 'core') === 'core')
      .map((tool) => {
      const schema = zodToJsonSchema(tool.input, { target: 'jsonSchema7', $refStrategy: 'none' }) as Record<
        string,
        unknown
      >
      delete schema.$schema
      return {
        name: tool.name,
        description: tool.description,
        input_schema: schema as unknown as Anthropic.Tool.InputSchema
      }
    })
  }

  /**
   * Validates raw (Claude-supplied) input against the tool's zod schema
   * before running it. Also the single choke point every tool call passes
   * through (voice-driven, dev-test, and the standalone self-test path
   * alike), so this is where tool-call diagnostics — adapter, timing,
   * exit code/stderr when the adapter provided any — get attached and
   * persisted to jarvis.log, per the "detailed tool diagnostics"
   * requirement. Never logs tool *arguments* beyond what's already
   * harmless (app names, volume percentages, URLs — no secrets ever flow
   * through tool input).
   */
  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) return { ok: false, message: `Unknown tool: ${name}.` }
    const parsed = tool.input.safeParse(rawInput)
    if (!parsed.success) {
      return { ok: false, message: `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}` }
    }

    const startedAt = Date.now()
    let result: ToolResult
    try {
      result = await tool.run(parsed.data, ctx)
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    const endedAt = Date.now()

    const merged: ToolResult = {
      ...result,
      diagnostics: { adapter: ctx.platform.name, startedAt, endedAt, durationMs: endedAt - startedAt, ...result.diagnostics }
    }

    const log = merged.ok ? logInfo : logError
    const exitPart = merged.diagnostics?.exitCode != null ? ` [exit ${merged.diagnostics.exitCode}]` : ''
    const stderrPart = merged.diagnostics?.stderr ? ` stderr="${merged.diagnostics.stderr.slice(0, 200)}"` : ''
    log(
      'tool',
      `${name}(${JSON.stringify(parsed.data)}) via ${ctx.platform.name} — ${merged.ok ? 'ok' : 'FAILED'} in ${merged.diagnostics!.durationMs}ms: ${merged.message}${exitPart}${stderrPart}`
    )

    return merged
  }
}

export const toolRegistry = new ToolRegistry()
