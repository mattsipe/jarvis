import { config } from '../../config'
import { logError } from '../../logger'
import { ElevenLabsTts } from './elevenlabs'

export type { TransportStatus } from '../transport/status'
export { ElevenLabsTts } from './elevenlabs'

/** The only place ElevenLabsTts's Electron-adjacent dependencies (API key, voice ID, logger) get wired in — see elevenlabs.ts's class doc comment for why they're injected rather than imported directly. */
export function createTtsProvider(): ElevenLabsTts {
  return new ElevenLabsTts({
    apiKey: config.elevenLabsApiKey,
    voiceId: config.elevenLabsVoiceId,
    logError
  })
}
