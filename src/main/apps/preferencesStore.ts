import { app } from 'electron'
import { join } from 'path'
import { logInfo } from '../logger'
import { AppPreferenceStore } from './preferences'

function filePath(): string {
  return join(app.getPath('userData'), 'app-preferences.json')
}

/** The only place AppPreferenceStore's real userData path and logger get wired in — see preferences.ts's class doc comment for why they're injected rather than imported directly. */
export const appPreferences = new AppPreferenceStore(filePath(), (entries) =>
  logInfo('apps:preferences', `${entries.length} app preference(s) persisted`)
)
