import { create } from 'zustand'
import type { HudState } from '../hud/core/params'

export type { HudState }

/**
 * Presentation mode — how large the expanded HUD renders. 'cinematic' is
 * the current full-size behaviour approved in M1 (unchanged default).
 * 'restrained' is a seam for a future "routine desktop use" mode that
 * doesn't dominate the screen during ordinary work — no trigger logic
 * exists yet to switch into it automatically; this just reserves the
 * plumbing per Weston's M2 review note, without redesigning the HUD.
 */
export type PresentationMode = 'cinematic' | 'restrained'

const AUTO_REVERT_MS: Partial<Record<HudState, number>> = {
  success: 1700,
  error: 2100
}

interface HudStoreState {
  state: HudState
  /** True while the dev switcher holds a state open for inspection (suppresses auto-revert). */
  held: boolean
  presentationMode: PresentationMode
  setState: (state: HudState) => void
  /** Used by the dev switcher — forces a state and disables its auto-revert timer. */
  devSetState: (state: HudState) => void
  setPresentationMode: (mode: PresentationMode) => void
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
  presentationMode: 'cinematic',

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
  },

  setPresentationMode: (mode) => set({ presentationMode: mode })
}))
