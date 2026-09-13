import { ipcMain } from 'electron'
import { setInteractive } from './window'

/**
 * Typed IPC surface between renderer and main. Channels are added here as
 * milestones land (voice loop in M2, tool activity in M3, etc.) — this file
 * is the single place renderer <-> main contracts are wired up.
 */
export function registerIpcHandlers(): void {
  ipcMain.on('hud:set-interactive', (_event, interactive: boolean) => {
    setInteractive(interactive)
  })
}
