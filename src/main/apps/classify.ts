import type { AppKind } from './catalog'

/**
 * Pure decision extracted from apps/catalog.ts's refreshCatalog() so the
 * Excel bug it fixes has a direct regression test — no Electron import
 * needed to verify "not a real path" always maps to "needs shell:AppsFolder
 * activation", regardless of what the AppID string itself looks like.
 *
 * Confirmed-real case this exists for: Office's Click-to-Run AppIDs
 * ("Microsoft.Office.EXCEL.EXE.15" and siblings) are NOT shaped like a
 * true UWP AppUserModelID (no `!`) and are NOT a real filesystem path —
 * the previous `!`-shape heuristic classified them as `isPath`-style
 * launch targets and tried to Start-Process a string that isn't a path,
 * which is exactly what broke "open Excel" on a real PC.
 */
export function classifyAppKind(isPath: boolean): AppKind {
  return isPath ? 'shortcut' : 'packaged'
}
