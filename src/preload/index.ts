import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

/**
 * Narrow, typed surface exposed to the renderer. No API keys, no Node
 * access, no raw ipcRenderer — only the specific calls the HUD needs.
 * Extended per milestone (voice events in M2, tool activity in M3, ...).
 */
const jarvisAPI = {
  /** Tell main whether the pointer is over interactive HUD content, so the
   *  click-through overlay can accept input only where it needs to. */
  setInteractive(interactive: boolean): void {
    ipcRenderer.send('hud:set-interactive', interactive)
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('jarvis', jarvisAPI)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.jarvis = jarvisAPI
}

export type JarvisAPI = typeof jarvisAPI
