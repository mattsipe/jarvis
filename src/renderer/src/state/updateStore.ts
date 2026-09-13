import { create } from 'zustand'

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error'

interface UpdateState {
  phase: UpdatePhase
  version: string | null
  percent: number
  message: string | null
  setFromMain: (state: Record<string, unknown>) => void
}

/**
 * Mirrors main's update state machine (see main/update/updater.ts) — main
 * owns electron-updater entirely, this store just reflects it for the
 * Command Center's UpdateBanner. 'not-available' briefly shows then clears
 * itself so a routine "you're up to date" doesn't linger.
 */
export const useUpdateStore = create<UpdateState>((set) => ({
  phase: 'idle',
  version: null,
  percent: 0,
  message: null,
  setFromMain: (state) => {
    const phase = state.phase as UpdatePhase
    set({
      phase,
      version: (state.version as string) ?? null,
      percent: (state.percent as number) ?? 0,
      message: (state.message as string) ?? null
    })
    if (phase === 'not-available') {
      setTimeout(() => set((s) => (s.phase === 'not-available' ? { phase: 'idle' } : s)), 4000)
    }
  }
}))
