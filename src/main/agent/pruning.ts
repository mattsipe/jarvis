import type Anthropic from '@anthropic-ai/sdk'

/**
 * In-turn tool-result pruning for the optimized engine — see the plan's
 * tool-result/context pruning design. Two independent techniques, both
 * applied after each tool-call iteration in agent/loopOptimized.ts:
 *  - stubOlderEphemeralResults: once a "look, don't remember" tool
 *    (ui_inspect, look_at_screen, ...) has been called more than once in
 *    the same turn, every result but the latest is replaced with a short
 *    placeholder — refs/state from an inspect stay valid, so nothing is
 *    lost that the model still needs.
 *  - capResultLength: a hard per-result character cap so one verbose tool
 *    message can't dominate a turn's token cost.
 * Both operate on the same in-turn `messages` array agent/loopOptimized.ts
 * already builds — no change to any tool's contract or ToolResult shape.
 */

/**
 * Tools whose result only matters for the *next* decision, not for the
 * historical record — see the plan's ephemeral/durable split. Kept as a
 * name allowlist here (rather than a new field on JarvisTool) so no
 * existing tool file needs touching for this to work.
 */
export const EPHEMERAL_TOOL_NAMES = new Set(['ui_inspect', 'ui_wait', 'look_at_screen', 'find_app', 'recall_memory', 'system_status'])

export const DEFAULT_RESULT_CHAR_CAP = 1500

function isToolResultBlock(block: unknown): block is Anthropic.ToolResultBlockParam {
  return typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result'
}

/**
 * Walks the in-turn message list from newest to oldest and, for each
 * ephemeral tool name, keeps only the first (i.e. most recent) result it
 * finds intact — every earlier one is replaced with a short placeholder.
 * `toolNameByUseId` is built incrementally by the caller as each
 * `tool_use` block is seen (its id → name), since a tool_result block
 * only carries the id, not the name.
 */
export function stubOlderEphemeralResults(messages: Anthropic.MessageParam[], toolNameByUseId: Map<string, string>): void {
  const seenLatest = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const block of msg.content as unknown[]) {
      if (!isToolResultBlock(block)) continue
      const toolName = toolNameByUseId.get(block.tool_use_id)
      if (!toolName || !EPHEMERAL_TOOL_NAMES.has(toolName)) continue
      if (seenLatest.has(toolName)) {
        block.content = `[earlier ${toolName} result omitted this turn — call it again if you need current state]`
      } else {
        seenLatest.add(toolName)
      }
    }
  }
}

/** Hard cap on one tool_result's text so a single verbose list can't dominate a turn's token cost. Images are untouched. */
export function capResultLength(text: string, max = DEFAULT_RESULT_CHAR_CAP): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}… +${text.length - max} more chars — narrow your query if you need the rest.`
}

/** Same screenshot-pruning behavior as the legacy engine's private helper (loopLegacy.ts) — kept here too so the optimized engine doesn't duplicate it. Replaces every image block before `keepIndex` with a text placeholder. */
export function stubOlderScreenshots(messages: Anthropic.MessageParam[], keepIndex: number): void {
  for (let i = 0; i < keepIndex; i++) {
    const msg = messages[i]
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    msg.content = msg.content.map((block) =>
      (block as { type?: unknown }).type === 'image' ? ({ type: 'text', text: '[earlier screenshot omitted]' } as unknown as Anthropic.ContentBlockParam) : block
    )
  }
}
