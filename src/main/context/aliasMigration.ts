/**
 * Pure matching logic behind MemoryStore.migrateLegacyAppAliases, pulled
 * out specifically so it's unit-testable without Electron/fs — see
 * memory.ts's class doc comment for the retired 'alias' memory kind this
 * exists to migrate off of, and the plan's root-cause writeup for why:
 * an 'alias' record's content used to be trusted as a launch target
 * directly, and a real regression saved a full sentence there instead of
 * a real app identifier.
 */
export interface LegacyAliasRecord {
  subject: string
  content: string
}

export interface CatalogAppRef {
  canonicalId: string
  displayName: string
}

/**
 * Returns the matching app's canonicalId only when the alias's saved
 * content is EXACTLY a real installed app's canonicalId or display name
 * (case-insensitive on the name) — never a fuzzy/partial match, since a
 * loose match here would just reintroduce a softer version of the same
 * "text becomes a launch target" bug this migration exists to fix. Free
 * text (the confirmed regression shape, e.g. "new Outlook, not classic")
 * matches nothing and returns null, which is the correct, safe outcome —
 * the record still becomes a preference, just an inert one.
 */
export function matchLegacyAliasToApp(alias: LegacyAliasRecord, catalog: CatalogAppRef[]): string | null {
  const match = catalog.find((a) => a.canonicalId === alias.content || a.displayName.toLowerCase() === alias.content.toLowerCase())
  return match?.canonicalId ?? null
}
