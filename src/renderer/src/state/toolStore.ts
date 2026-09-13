import { create } from 'zustand'

export type RiskLevel = 'safe' | 'moderate' | 'elevated'

export interface PendingConfirmation {
  id: string
  toolName: string
  description: string
}

export interface ToolDiagnostics {
  adapter?: 'darwin' | 'win32'
  durationMs?: number
  exitCode?: number | null
  stderr?: string
}

export interface ToolActivityEntry {
  id: string
  name: string
  risk: RiskLevel
  input: unknown
  status: 'started' | 'confirm-pending' | 'success' | 'error' | 'denied'
  message?: string
  timestamp: string
  diagnostics?: ToolDiagnostics
}

interface ToolStoreState {
  pending: PendingConfirmation | null
  activity: ToolActivityEntry[]
  setPending: (p: PendingConfirmation | null) => void
  upsertActivity: (e: ToolActivityEntry) => void
  setActivityHistory: (list: ToolActivityEntry[]) => void
}

/**
 * Mirrors main's tool-confirmation and tool-activity broadcasts (see
 * main/tools/confirmation.ts and main/tools/activity.ts) — one instance
 * per renderer process (Ambient + Command Center each keep their own,
 * both fed by the same IPC events, per the plan's "single source of
 * truth in main" approach used throughout the voice loop).
 */
export const useToolStore = create<ToolStoreState>((set) => ({
  pending: null,
  activity: [],
  setPending: (p) => set({ pending: p }),
  upsertActivity: (e) =>
    set((s) => {
      const idx = s.activity.findIndex((a) => a.id === e.id)
      const next = [...s.activity]
      if (idx >= 0) next[idx] = e
      else next.unshift(e)
      return { activity: next.slice(0, 20) }
    }),
  setActivityHistory: (list) => set({ activity: list })
}))
