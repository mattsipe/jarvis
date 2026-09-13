import { broadcast } from '../window'
import type { RiskLevel } from './registry'

export interface ToolActivityEntry {
  id: string
  name: string
  risk: RiskLevel
  input: unknown
  status: 'started' | 'confirm-pending' | 'success' | 'error' | 'denied'
  message?: string
  timestamp: string
}

const HISTORY_LIMIT = 20
const history: ToolActivityEntry[] = []

/**
 * Feeds both HUD surfaces' "what tool is running" / "recent actions" UI —
 * see the plan's requirement that tool execution visibly update both
 * Ambient and Command Center. One in-memory ring buffer, broadcast on
 * every change; Command Center also pulls the current buffer on open via
 * the 'tool:activity-history' IPC query (see ipc.ts).
 */
export function recordToolActivity(entry: ToolActivityEntry): void {
  const idx = history.findIndex((e) => e.id === entry.id)
  if (idx >= 0) history[idx] = entry
  else history.unshift(entry)
  while (history.length > HISTORY_LIMIT) history.pop()
  broadcast('tool:activity', entry)
}

export function getToolActivityHistory(): ToolActivityEntry[] {
  return [...history]
}
