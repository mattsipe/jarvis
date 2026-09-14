import { create } from 'zustand'

export type RiskLevel = 'safe' | 'moderate' | 'elevated'

export interface PendingConfirmation {
  id: string
  toolName: string
  description: string
}

export interface LaunchTrace {
  request: string
  normalizedQuery: string
  preference: { query: string; canonicalId: string | null; status: 'applied' | 'none' | 'ignored-not-installed' }
  candidates: { displayName: string; canonicalId: string; launchKind: string; score: number }[]
  selected: { displayName: string; canonicalId: string } | null
  registrationSource: string | null
  activationMethod: string | null
  activationTarget: string | null
  activationResult: 'ok' | { error: string } | null
  observed: { pid: number; processName: string } | null
  confidence: 'confirmed' | 'existing-instance' | 'unverified' | null
  finalResult: 'launched' | 'accepted' | 'failed' | 'ambiguous' | 'not-installed'
}

export interface ToolDiagnostics {
  adapter?: 'darwin' | 'win32'
  durationMs?: number
  exitCode?: number | null
  stderr?: string
  /** open_app's full resolution+launch record — see main/apps/types.ts's LaunchTrace. */
  launchTrace?: LaunchTrace
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
