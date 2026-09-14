import { config } from '../../config'
import { budgetManager } from '../../usage'
import { logInfo, logError } from '../../logger'
import { DeepgramStt } from './deepgram'
import type { SttProvider } from './types'

export type { SttProvider, TranscriptEvent } from './types'

/**
 * Provider selected via STT_PROVIDER (config/settings), Deepgram default.
 * whisper.cpp (local, offline fallback) is planned per the architecture
 * plan but not yet implemented — selecting it fails clearly rather than
 * silently falling back, so a misconfiguration is never mistaken for a
 * working offline mode.
 *
 * This is the only place DeepgramStt's Electron-adjacent dependencies
 * (API key, budget gate, logger) get wired in — see deepgram.ts's class
 * doc comment for why they're injected rather than imported directly.
 */
export function createSttProvider(): SttProvider {
  if (config.sttProvider === 'whisper') {
    throw new Error(
      '[jarvis] STT_PROVIDER=whisper is not implemented yet — the offline fallback is planned but not built. Set STT_PROVIDER=deepgram (the default).'
    )
  }
  return new DeepgramStt({
    apiKey: config.deepgramApiKey,
    checkBudget: () => budgetManager.checkDeepgramStream(),
    logInfo,
    logError
  })
}
