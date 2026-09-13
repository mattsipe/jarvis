import 'dotenv/config'

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    throw new Error(
      `[jarvis] Missing required env var ${name}. Copy .env.example to .env and fill it in.`
    )
  }
  return v
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '2eG0V12z6Hg7luZwRG2V',
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  sttProvider: (process.env.STT_PROVIDER as 'deepgram' | 'whisper') || 'deepgram',
  hotkey: process.env.JARVIS_HOTKEY || 'Control+Space',
  commandCenterHotkey: process.env.JARVIS_COMMAND_CENTER_HOTKEY || 'Control+Shift+Space',
  /** Hard cap on one continuous voice session, regardless of activity — see the API-safeguards priority. */
  maxSessionMinutes: process.env.JARVIS_MAX_SESSION_MINUTES
    ? parseInt(process.env.JARVIS_MAX_SESSION_MINUTES, 10)
    : 10,
  /** Optional dev safety valve: stop synthesizing (but keep showing text) past this many characters in one session. Unset = no cap. */
  ttsDevCharCap: process.env.TTS_DEV_CHAR_CAP ? parseInt(process.env.TTS_DEV_CHAR_CAP, 10) : undefined
}

export function assertVoiceLoopConfigured(): void {
  required('ANTHROPIC_API_KEY')
  required('ELEVENLABS_API_KEY')
  required('DEEPGRAM_API_KEY')
}
