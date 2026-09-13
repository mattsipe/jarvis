import { config } from '../../config'
import { DeepgramStt } from './deepgram'
import type { SttProvider } from './types'

export type { SttProvider, TranscriptEvent } from './types'

/**
 * Provider selected via STT_PROVIDER (config/settings), Deepgram default.
 * whisper.cpp (local, offline fallback) is planned per the architecture
 * plan but not yet implemented — selecting it fails clearly rather than
 * silently falling back, so a misconfiguration is never mistaken for a
 * working offline mode.
 */
export function createSttProvider(): SttProvider {
  if (config.sttProvider === 'whisper') {
    throw new Error(
      '[jarvis] STT_PROVIDER=whisper is not implemented yet — the offline fallback is planned but not built. Set STT_PROVIDER=deepgram (the default).'
    )
  }
  return new DeepgramStt()
}
