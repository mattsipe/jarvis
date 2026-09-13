import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type Anthropic from '@anthropic-ai/sdk'
import type { PlatformControl, ToolResult } from '../platform/types'
import type { ContextManager } from '../context'

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
  risk: RiskLevel
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>
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

  /** Converts every registered tool into Claude's tool-use format. */
  toAnthropicTools(): Anthropic.Tool[] {
    return this.list().map((tool) => {
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

  /** Validates raw (Claude-supplied) input against the tool's zod schema before running it. */
  async execute(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.get(name)
    if (!tool) return { ok: false, message: `Unknown tool: ${name}.` }
    const parsed = tool.input.safeParse(rawInput)
    if (!parsed.success) {
      return { ok: false, message: `Invalid input for ${name}: ${parsed.error.issues.map((i) => i.message).join('; ')}` }
    }
    try {
      return await tool.run(parsed.data, ctx)
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}

export const toolRegistry = new ToolRegistry()
