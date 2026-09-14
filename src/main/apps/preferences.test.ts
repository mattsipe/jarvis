import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { AppPreferenceStore } from './preferences'

let dir: string

function makeStore(): { store: AppPreferenceStore; path: string } {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-prefs-test-'))
  const path = join(dir, 'app-preferences.json')
  return { store: new AppPreferenceStore(path), path }
}

describe('apps/preferences AppPreferenceStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    // Flush any pending debounced save before removing its directory —
    // otherwise a scheduled write can fire against an already-deleted
    // temp dir once fake timers are torn down and real ones resume.
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for a query with no preference', () => {
    const { store } = makeStore()
    expect(store.get('outlook')).toBeNull()
  })

  it('stores and retrieves a preference by normalized query', () => {
    const { store } = makeStore()
    store.set('Outlook', 'Microsoft.OutlookForWindows_8wekyb3d8bbwe!App')
    expect(store.get('outlook')).toBe('Microsoft.OutlookForWindows_8wekyb3d8bbwe!App')
    expect(store.get('  Outlook  ')).toBe('Microsoft.OutlookForWindows_8wekyb3d8bbwe!App')
  })

  it('updates an existing preference rather than duplicating it', () => {
    const { store } = makeStore()
    store.set('outlook', 'id-1')
    store.set('outlook', 'id-2')
    expect(store.get('outlook')).toBe('id-2')
    expect(store.list().filter((e) => e.query === 'outlook')).toHaveLength(1)
  })

  it('persists to disk and reloads correctly in a new instance', () => {
    const { store, path } = makeStore()
    store.set('outlook', 'id-1')
    vi.advanceTimersByTime(600) // scheduleSave debounces by 500ms
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    expect(raw.entries).toHaveLength(1)

    const reloaded = new AppPreferenceStore(path)
    expect(reloaded.get('outlook')).toBe('id-1')
  })

  it('remove() deletes a preference', () => {
    const { store } = makeStore()
    store.set('outlook', 'id-1')
    expect(store.remove('outlook')).toBe(true)
    expect(store.get('outlook')).toBeNull()
    expect(store.remove('outlook')).toBe(false)
  })

  it('starts empty when the file does not exist yet', () => {
    const { store } = makeStore()
    expect(store.list()).toEqual([])
  })
})
