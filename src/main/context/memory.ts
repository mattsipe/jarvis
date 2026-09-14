import { app } from 'electron'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync } from 'fs'
import { logInfo } from '../logger'
import { matchLegacyAliasToApp, type CatalogAppRef } from './aliasMigration'
import type { PersistentContext } from './types'

export type MemoryKind = 'preference' | 'person' | 'project' | 'routine' | 'device' | 'task' | 'fact' | 'learned'
export type MemorySource = 'explicit' | 'learned'

export interface MemoryRecord {
  id: string
  kind: MemoryKind
  /** What this is about — an app name for an alias, a person's name, a project name, etc. Matched case-insensitively on recall. */
  subject: string
  content: string
  tags: string[]
  source: MemorySource
  /** 1.0 for anything explicit. Learned records carry the auto-learn pass's confidence and only enter the always-on block above LEARNED_ALWAYS_ON_THRESHOLD. */
  confidence: number
  createdAt: string
  updatedAt: string
  useCount: number
  lastUsedAt?: string
}

interface MemoryFile {
  version: 1
  records: MemoryRecord[]
}

const LEARNED_ALWAYS_ON_THRESHOLD = 0.7
const ALWAYS_ON_MAX_PREFERENCES = 12
const ALWAYS_ON_MAX_PEOPLE_PROJECTS = 6

function memoryFilePath(): string {
  return join(app.getPath('userData'), 'memory.json')
}

function now(): string {
  return new Date().toISOString()
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/**
 * Operational memory — the "fast" layer from the capability-phase plan:
 * aliases, preferences, people, projects, routines, devices, recurring
 * tasks, explicit facts, and silently-learned context. Plain JSON, not a
 * database (a single user with a few thousand records at most doesn't
 * need one — same reasoning as context/store.ts). The Obsidian vault
 * (Phase 4) is a human-readable *mirror* of this, never the source of
 * truth for runtime reads.
 *
 * Explicit records always win over learned ones: `alwaysOnBlock()` only
 * includes a learned record once its confidence clears
 * LEARNED_ALWAYS_ON_THRESHOLD, and recall() ranks explicit above learned
 * at equal keyword-match scores.
 */
export class MemoryStore {
  private records: MemoryRecord[] = []
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.records = this.load()
  }

  private load(): MemoryRecord[] {
    try {
      const raw = readFileSync(memoryFilePath(), 'utf-8')
      const parsed = JSON.parse(raw) as MemoryFile
      return Array.isArray(parsed.records) ? parsed.records : []
    } catch {
      return []
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      try {
        const file: MemoryFile = { version: 1, records: this.records }
        writeFileSync(memoryFilePath(), JSON.stringify(file, null, 2), 'utf-8')
      } catch (err) {
        console.warn('[jarvis] Failed to persist memory.json:', (err as Error).message)
      }
    }, 1000)
  }

  list(filter?: { kind?: MemoryKind; source?: MemorySource }): MemoryRecord[] {
    return this.records
      .filter((r) => !filter?.kind || r.kind === filter.kind)
      .filter((r) => !filter?.source || r.source === filter.source)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): MemoryRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  /**
   * Adds a record, or — if an existing non-superseded record shares the
   * same kind + subject (case-insensitive) — updates that one in place
   * instead of duplicating it. This is what makes "remember that Outlook
   * means new Outlook" said twice update the same alias rather than
   * create two.
   */
  upsert(input: { kind: MemoryKind; subject: string; content: string; tags?: string[]; source: MemorySource; confidence?: number }): MemoryRecord {
    const existing = this.records.find((r) => r.kind === input.kind && r.subject.toLowerCase() === input.subject.toLowerCase())
    if (existing) {
      existing.content = input.content
      existing.tags = input.tags ?? existing.tags
      existing.updatedAt = now()
      // An explicit correction always overrides a previously-learned guess; never the other way around.
      if (input.source === 'explicit') {
        existing.source = 'explicit'
        existing.confidence = 1
      }
      this.scheduleSave()
      return existing
    }
    const record: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      subject: input.subject,
      content: input.content,
      tags: input.tags ?? [],
      source: input.source,
      confidence: input.source === 'explicit' ? 1 : (input.confidence ?? 0.6),
      createdAt: now(),
      updatedAt: now(),
      useCount: 0
    }
    this.records.push(record)
    this.scheduleSave()
    return record
  }

  update(id: string, patch: { content?: string; tags?: string[] }): MemoryRecord | null {
    const record = this.get(id)
    if (!record) return null
    if (patch.content !== undefined) record.content = patch.content
    if (patch.tags !== undefined) record.tags = patch.tags
    record.updatedAt = now()
    this.scheduleSave()
    return record
  }

  remove(id: string): boolean {
    const idx = this.records.findIndex((r) => r.id === id)
    if (idx < 0) return false
    this.records.splice(idx, 1)
    this.scheduleSave()
    return true
  }

  /** Keyword/fuzzy recall — no embeddings for Phase 1 (see the plan: only added if this proves too weak in practice). */
  recall(query: string, limit = 5): MemoryRecord[] {
    const queryTokens = tokenize(query)
    if (queryTokens.length === 0) return []
    const scored = this.records
      .map((record) => {
        const haystack = tokenize(`${record.subject} ${record.content} ${record.tags.join(' ')}`)
        let score = 0
        for (const qt of queryTokens) {
          if (haystack.includes(qt)) score += 2
          else if (haystack.some((h) => h.includes(qt) || qt.includes(h))) score += 1
        }
        if (record.subject.toLowerCase().includes(query.toLowerCase())) score += 3
        if (record.source === 'explicit') score += 0.5
        return { record, score }
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    for (const { record } of scored) {
      record.useCount += 1
      record.lastUsedAt = now()
    }
    if (scored.length > 0) this.scheduleSave()
    return scored.map((s) => s.record)
  }

  /**
   * Compact, cheap-to-read block for every turn's system prompt (its own
   * cache breakpoint in agent/loop.ts, separate from the persona and the
   * per-turn live-context block since it changes far less often than
   * either). Capped by item count, not tokens exactly, but the caps below
   * keep it well under ~600 tokens in practice.
   */
  alwaysOnBlock(): string {
    const lines: string[] = []

    const preferenceRecords = this.records
      .filter((r) => r.kind === 'preference' && this.isAlwaysOnEligible(r))
      .slice(0, ALWAYS_ON_MAX_PREFERENCES)
    if (preferenceRecords.length > 0) {
      lines.push(`Preferences: ${preferenceRecords.map((r) => `${r.subject}: ${r.content}`).join('; ')}.`)
    }

    const peopleProjects = this.records
      .filter((r) => (r.kind === 'person' || r.kind === 'project') && this.isAlwaysOnEligible(r))
      .sort((a, b) => (b.lastUsedAt ?? b.updatedAt).localeCompare(a.lastUsedAt ?? a.updatedAt) || b.useCount - a.useCount)
      .slice(0, ALWAYS_ON_MAX_PEOPLE_PROJECTS)
    if (peopleProjects.length > 0) {
      lines.push(`People/projects: ${peopleProjects.map((r) => `${r.subject} (${r.content})`).join('; ')}.`)
    }

    return lines.join(' ')
  }

  private isAlwaysOnEligible(r: MemoryRecord): boolean {
    return r.source === 'explicit' || r.confidence >= LEARNED_ALWAYS_ON_THRESHOLD
  }

  /**
   * One-time move of the fields PersistentContext originally reserved for
   * this (appAliases/preferences/devices/routines/learnedContext) into
   * proper memory records. Guarded by the caller checking
   * persistent.migratedToMemory first — see context/index.ts.
   */
  migrateFromPersistentContext(persistent: PersistentContext): void {
    // These become plain preference text, never a structured app
    // preference — this legacy field predates the app-launch rebuild and
    // has no canonicalId to check against the catalog. Anything here that
    // happens to reference a real installed app is picked up by
    // migrateLegacyAppAliases() below on the very next call, same as any
    // other pre-rebuild 'alias' record.
    for (const [subject, content] of Object.entries(persistent.appAliases)) {
      this.upsert({ kind: 'preference', subject, content, source: 'explicit' })
    }
    for (const [subject, content] of Object.entries(persistent.preferences)) {
      this.upsert({ kind: 'preference', subject, content: String(content), source: 'explicit' })
    }
    for (const device of persistent.devices) {
      this.upsert({ kind: 'device', subject: device, content: device, source: 'explicit' })
    }
    for (const routine of persistent.routines) {
      this.upsert({ kind: 'routine', subject: routine.name, content: routine.description, source: 'explicit' })
    }
    for (const [subject, content] of Object.entries(persistent.learnedContext)) {
      this.upsert({ kind: 'learned', subject, content: String(content), source: 'learned', confidence: 0.6 })
    }
    logInfo('memory', `migrated legacy PersistentContext fields into memory.json (${this.records.length} records total)`)
  }

  /**
   * One-time move off the 'alias' memory kind, retired because it let app-
   * preference PROSE ("Outlook means new Outlook, not classic") become a
   * literal launch target — see apps/launchApp.ts, which never reads
   * memory at all now, and the plan's root-cause writeup for the real-PC
   * regression this traces to.
   *
   * Every old 'alias' record becomes a plain 'preference' record (still
   * visible to Claude in the always-on block, never launched); if its
   * content exactly matches a currently-installed app's canonicalId or
   * display name, a real, catalog-checked AppPreference is also created
   * via `setPreference` so the ranking boost isn't lost for the common
   * case — but a record whose content is free text (the confirmed
   * regression shape) simply has no match and stays inert prose, exactly
   * as it should.
   *
   * Called once at startup, after the catalog has already loaded its
   * cache — see main/index.ts.
   */
  migrateLegacyAppAliases(catalog: CatalogAppRef[], setPreference: (query: string, canonicalId: string) => void): void {
    // TypeScript no longer allows 'alias' in MemoryKind, but records
    // loaded from an older memory.json can still carry it — hence the
    // string cast rather than a type-narrowed filter.
    const legacyAliases = this.records.filter((r) => (r.kind as string) === 'alias')
    if (legacyAliases.length === 0) return
    let matched = 0
    for (const r of legacyAliases) {
      const canonicalId = matchLegacyAliasToApp({ subject: r.subject, content: r.content }, catalog)
      if (canonicalId) {
        setPreference(r.subject, canonicalId)
        matched++
      }
      r.kind = 'preference'
      r.updatedAt = now()
    }
    this.scheduleSave()
    logInfo('memory', `migrated ${legacyAliases.length} legacy 'alias' record(s) to preferences (${matched} matched a real installed app)`)
  }
}

export const memoryStore = new MemoryStore()
