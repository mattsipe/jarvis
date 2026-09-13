import { create } from 'zustand'
import type { HudState } from '../hud/core/params'

export type { HudState }

const AUTO_REVERT_MS: Partial<Record<HudState, number>> = {
  success: 1700,
  error: 2100
}

interface HudStoreState {
  state: HudState
  /** True while the dev switcher holds a state open for inspection (suppresses auto-revert). */
  held: boolean
  setState: (state: HudState) => void
  /** Used by the dev switcher — forces a state and disables its auto-revert timer. */
  devSetState: (state: HudState) => void
}

let revertTimer: ReturnType<typeof setTimeout> | null = null

function clearRevertTimer(): void {
  if (revertTimer) {
    clearTimeout(revertTimer)
    revertTimer = null
  }
}

export const useHudStore = create<HudStoreState>((set, get) => ({
  state: 'ambient',
  held: false,

  setState: (state) => {
    clearRevertTimer()
    set({ state, held: false })
    const revertAfter = AUTO_REVERT_MS[state]
    if (revertAfter) {
      revertTimer = setTimeout(() => {
        if (get().state === state) set({ state: 'ambient' })
      }, revertAfter)
    }
  },

  devSetState: (state) => {
    clearRevertTimer()
    set({ state, held: true })
  }
}))
