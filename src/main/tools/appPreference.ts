import { z } from 'zod'
import type { JarvisTool } from './registry'
import { getCatalog } from '../apps/catalog'
import { appPreferences } from '../apps/preferencesStore'

/**
 * The ONLY way an app preference gets written — and it enforces the
 * invariant that keeps this whole rebuild from regressing back into the
 * old bug: `canonicalId` is checked against the live catalog before
 * anything is persisted, so nothing that isn't a real, currently-
 * installed application can ever end up as a preference target. See the
 * plan's root-cause writeup: the previous "alias" mechanism accepted
 * arbitrary text (a whole sentence, in the confirmed regression) with no
 * such check at all.
 */
export const setAppPreferenceTool: JarvisTool = {
  name: 'set_app_preference',
  description:
    'Remember which installed application "X" should mean, after open_app returned real ambiguous candidates and Weston picked one. Pass the exact canonicalId from that candidate list — never a name, description, or free text. Use this instead of the old "remember" alias flow for app choices.',
  risk: 'safe',
  input: z.object({
    query: z.string().describe('The name Weston used when asking to open something, e.g. "Outlook".'),
    canonicalId: z
      .string()
      .describe('The exact canonicalId of the candidate he picked, taken verbatim from open_app\'s ambiguous-candidates list.')
  }),
  run: async (input) => {
    const match = getCatalog().find((a) => a.canonicalId === input.canonicalId)
    if (!match) {
      return {
        ok: false,
        message: `"${input.canonicalId}" isn't a currently installed application — can't set that preference. Use the exact canonicalId from open_app's candidates.`
      }
    }
    appPreferences.set(input.query, match.canonicalId)
    return { ok: true, message: `Got it — "${input.query}" now means ${match.displayName}.` }
  }
}
