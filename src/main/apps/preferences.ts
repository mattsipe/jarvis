import { readFileSync, writeFileSync } from 'fs'

/**
 * A structured, typed record of "when Weston says X, prefer this exact
 * installed app" — kept entirely separate from prose memory (see the
 * plan's root-cause writeup: a preference used to live as free text in a
 * memory 'alias' record, and that text ended up being launched directly).
 * `preferCanonicalId` must be a currently-installed app's canonicalId —
 * enforced by the caller (tools/appPreference.ts checks it against the
 * live catalog before ever calling set()); this store itself doesn't
 * import the catalog; it just persists whatever it's given.
 */
export interface AppPreference {
  /** Normalized (lowercased, trimmed) — what Weston said. */
  query: string
  preferCanonicalId: string
  createdAt: string
  source: 'user-choice'
}

interface PreferencesFile {
  version: 1
  entries: AppPreference[]
}

/**
 * No Electron/logger imports, deliberately — see voice/stt/deepgram.ts's
 * DeepgramDeps for the same pattern and why (fully unit-testable with a
 * plain temp file path). apps/preferencesStore.ts wires the real userData
 * path and logger for production use.
 */
export class AppPreferenceStore {
  private entries: AppPreference[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly filePath: string,
    private readonly onChange?: (entries: AppPreference[]) => void
  ) {
    this.entries = this.load()
  }

  private load(): AppPreference[] {
    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as PreferencesFile
      return Array.isArray(parsed.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        const file: PreferencesFile = { version: 1, entries: this.entries }
        writeFileSync(this.filePath, JSON.stringify(file, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[jarvis] Failed to persist app-preferences.json:', (err as Error).message)
      }
    }, 500)
  }

  /** Only ever used as a ranking boost (apps/rank.ts) — never as a launch target directly. */
  get(query: string): string | null {
    const q = query.toLowerCase().trim()
    return this.entries.find((e) => e.query === q)?.preferCanonicalId ?? null
  }

  set(query: string, preferCanonicalId: string): AppPreference {
    const q = query.toLowerCase().trim()
    const existing = this.entries.find((e) => e.query === q)
    const createdAt = new Date().toISOString()
    if (existing) {
      existing.preferCanonicalId = preferCanonicalId
      existing.createdAt = createdAt
      this.scheduleSave()
      this.onChange?.(this.entries)
      return existing
    }
    const record: AppPreference = { query: q, preferCanonicalId, createdAt, source: 'user-choice' }
    this.entries.push(record)
    this.scheduleSave()
    this.onChange?.(this.entries)
    return record
  }

  remove(query: string): boolean {
    const q = query.toLowerCase().trim()
    const idx = this.entries.findIndex((e) => e.query === q)
    if (idx < 0) return false
    this.entries.splice(idx, 1)
    this.scheduleSave()
    this.onChange?.(this.entries)
    return true
  }

  list(): AppPreference[] {
    return [...this.entries]
  }
}
