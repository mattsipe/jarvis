import { ElectronAPI } from '@electron-toolkit/preload'
import type { JarvisAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    jarvis: JarvisAPI
  }
}
