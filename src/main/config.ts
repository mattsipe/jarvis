import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'fs'
import dotenv from 'dotenv'
import { is } from '@electron-toolkit/utils'
import { logInfo, logError, getLogFilePath } from './logger'

// Force a deterministic app name BEFORE any app.getPath() call below — but
// see CONFIG_DIR just below, which no longer actually depends on this for
// correctness. Kept because it also drives the taskbar/Start Menu identity.
app.setName('jarvis')

// electron-builder's own default for a Windows NSIS install already targets
// the packaged app's `name` field ("jarvis", lowercase — see package.json;
// productName "JARVIS" only affects the install directory/shortcut text,
// never userData), so app.getPath('userData') *should* already resolve to
// %APPDATA%\jarvis. But this is exactly the kind of thing this bug report
// asked us to stop assuming: Electron can, in principle, resolve app.name
// differently across a dev run vs. a packaged run vs. a future rename of
// productName, and any drift here silently splits users onto two different
// config directories with no error from anyone. So CONFIG_DIR is pinned
// explicitly to appData + the literal folder name "jarvis", and every other
// module that used to call app.getPath('userData') directly (context/store,
// usage/tracker, context/local) now goes through app.getPath('userData') as
// usual — but userData itself is *overridden* to this exact path via
// app.setPath below, so there is only ever one real config directory, and
// diagnostics can report its exact value instead of us guessing at it from
// outside the app.
const CONFIG_DIR = is.dev ? undefined : join(app.getPath('appData'), 'jarvis')
if (CONFIG_DIR) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  app.setPath('userData', CONFIG_DIR)
}

// Canonical .env location — this is also where the first-run/API-config UI
// (see saveApiKeys below) always writes, regardless of where a pre-existing
// file was discovered.
const ENV_PATH = CONFIG_DIR ? join(CONFIG_DIR, '.env') : undefined

/** Strips whichever BOM/encoding Notepad happened to save with — dotenv only handles bare UTF-8. */
function decodeEnvFile(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le') // UTF-16 LE BOM — Notepad's legacy "Unicode" option
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i]
      swapped[i] = swapped[i + 1]
      swapped[i + 1] = tmp
    }
    return swapped.toString('utf16le') // UTF-16 BE BOM
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8') // UTF-8 BOM
  }
  return buf.toString('utf8')
}

/**
 * Finds a real .env file in `dir` even if it isn't spelled exactly ".env" —
 * the single most common real-world Windows footgun is Notepad's Save As
 * dialog silently appending ".txt" to a file the user typed as ".env"
 * (defaults to "Text Documents (*.txt)" unless changed to "All Files"), or
 * Explorer's "hide extensions for known file types" doing the same thing
 * invisibly after a rename. Matched case-insensitively since Windows'
 * default filesystem (NTFS) is case-insensitive anyway.
 */
function discoverEnvFile(dir: string): string | null {
  const canonical = join(dir, '.env')
  if (existsSync(canonical)) return canonical
  try {
    const hit = readdirSync(dir).find((f) => /^\.env(\.txt)?$/i.test(f) || /^env\.txt$/i.test(f))
    return hit ? join(dir, hit) : null
  } catch {
    return null // dir may not exist yet on a brand-new install
  }
}

let envFileUsed: string | null = null
let envLoadError: string | null = null
let migratedFrom: string | null = null

function loadEnv(): void {
  if (is.dev || !CONFIG_DIR || !ENV_PATH) return // dev keeps dotenv's own project-root default, unchanged

  let found = discoverEnvFile(CONFIG_DIR)

  // One-time, fully automatic migration off any legacy location — never
  // asks the user to go hunting for files themselves. Covers: a previous
  // build that (before this fix) resolved userData to a different name; a
  // .env accidentally left in the app's own working directory; and the
  // pre-override default Electron would have used based on productName.
  if (!found) {
    const legacyDirs = [
      join(app.getPath('appData'), 'JARVIS'),
      join(app.getPath('appData'), 'com.weston.jarvis'),
      process.cwd()
    ]
    for (const dir of legacyDirs) {
      const legacy = discoverEnvFile(dir)
      if (legacy) {
        try {
          copyFileSync(legacy, ENV_PATH)
          migratedFrom = legacy
          found = ENV_PATH
          logInfo('config', `migrated .env from legacy location ${legacy} -> ${ENV_PATH}`)
        } catch (err) {
          logError('config', `found legacy .env at ${legacy} but failed to migrate it: ${(err as Error).message}`)
        }
        break
      }
    }
  }

  if (!found) return
  envFileUsed = found
  try {
    const parsed = dotenv.parse(decodeEnvFile(readFileSync(found)))
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v
    }
  } catch (err) {
    envLoadError = (err as Error).message
    logError('config', `found ${found} but failed to parse it: ${envLoadError}`)
  }
}

loadEnv()

// Never logs key values — only presence — but this is the single most
// useful line for diagnosing "voice doesn't work" on a machine we can't
// see: it says exactly where JARVIS looked and what it found. Written to
// a log file too, since a packaged Windows build has no visible console.
// Also surfaced live in Command Center — see getConfigDiagnostics below.
logInfo(
  'config',
  `configDir=${CONFIG_DIR ?? 'project root (dev)'} envFile=${envFileUsed ?? 'none found'} migratedFrom=${migratedFrom ?? 'n/a'} — ANTHROPIC_API_KEY:${Boolean(process.env.ANTHROPIC_API_KEY)} ELEVENLABS_API_KEY:${Boolean(process.env.ELEVENLABS_API_KEY)} DEEPGRAM_API_KEY:${Boolean(process.env.DEEPGRAM_API_KEY)} — log file: ${getLogFilePath()}`
)

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
  ttsDevCharCap: process.env.TTS_DEV_CHAR_CAP ? parseInt(process.env.TTS_DEV_CHAR_CAP, 10) : undefined,
  /** 'test' allows prerelease versions (e.g. "0.2.0-test.1"); 'stable' only installs plain-semver releases. See update/updater.ts. */
  updateChannel: (process.env.JARVIS_UPDATE_CHANNEL as 'test' | 'stable') || 'test'
}

export function assertVoiceLoopConfigured(): void {
  required('ANTHROPIC_API_KEY')
  required('ELEVENLABS_API_KEY')
  required('DEEPGRAM_API_KEY')
}

export interface ConfigDiagnostics {
  configDir: string
  envPath: string
  envFound: boolean
  envFileUsed: string | null
  envLoadError: string | null
  migratedFrom: string | null
  claudeKeyLoaded: boolean
  deepgramKeyLoaded: boolean
  elevenLabsKeyLoaded: boolean
}

/** Powers the Command Center's Integrations diagnostics — never returns key values, only presence/paths. */
export function getConfigDiagnostics(): ConfigDiagnostics {
  const dir = CONFIG_DIR ?? join(process.cwd(), '(dev — project root .env)')
  return {
    configDir: dir,
    envPath: ENV_PATH ?? join(dir, '.env'),
    envFound: is.dev ? Boolean(process.env.ANTHROPIC_API_KEY || process.env.DEEPGRAM_API_KEY || process.env.ELEVENLABS_API_KEY) : envFileUsed !== null,
    envFileUsed,
    envLoadError,
    migratedFrom,
    claudeKeyLoaded: Boolean(config.anthropicApiKey),
    deepgramKeyLoaded: Boolean(config.deepgramApiKey),
    elevenLabsKeyLoaded: Boolean(config.elevenLabsApiKey)
  }
}

/**
 * Writes/updates the three API keys straight to the canonical .env file —
 * the first-run/API-config UI's backing call. Merges with whatever's
 * already in the file (so re-saving one key never drops the others),
 * always normalizes onto ENV_PATH going forward (even if the file that was
 * loaded came from a migrated legacy location or a ".env.txt" variant), and
 * updates the live `config` object immediately so already-running code
 * picks the new values up without an app restart.
 */
export function saveApiKeys(keys: { anthropic?: string; deepgram?: string; elevenlabs?: string }): ConfigDiagnostics {
  if (is.dev || !CONFIG_DIR || !ENV_PATH) {
    throw new Error('Saving API keys from the UI is only supported in a packaged build — edit the project .env in dev.')
  }
  mkdirSync(CONFIG_DIR, { recursive: true })
  const source = envFileUsed ?? ENV_PATH
  const existing = existsSync(source) ? dotenv.parse(decodeEnvFile(readFileSync(source))) : {}

  if (keys.anthropic !== undefined) existing.ANTHROPIC_API_KEY = keys.anthropic.trim()
  if (keys.deepgram !== undefined) existing.DEEPGRAM_API_KEY = keys.deepgram.trim()
  if (keys.elevenlabs !== undefined) existing.ELEVENLABS_API_KEY = keys.elevenlabs.trim()

  const body = Object.entries(existing)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
  writeFileSync(ENV_PATH, body + '\n', 'utf-8')

  envFileUsed = ENV_PATH
  envLoadError = null
  for (const [k, v] of Object.entries(existing)) process.env[k] = v
  config.anthropicApiKey = process.env.ANTHROPIC_API_KEY || ''
  config.deepgramApiKey = process.env.DEEPGRAM_API_KEY || ''
  config.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY || ''

  logInfo('config', `API keys saved via Command Center to ${ENV_PATH}`)
  return getConfigDiagnostics()
}
