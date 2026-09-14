/**
 * PowerShell serializes a terminating/non-terminating error to stderr as
 * CLIXML (an XML dump of the ErrorRecord object, prefixed with a literal
 * "#< CLIXML" line) whenever it can't just print plain text — this is
 * what was leaking straight into Recent Actions as raw XML/progress
 * junk. Pure and independently testable: no PowerShell/Electron needed to
 * verify this extracts something readable, or degrades gracefully when it
 * can't.
 */

/** CLIXML escapes non-printable/reserved characters as `_xHHHH_` (hex UTF-16 code unit) — reverses that. */
function decodeCliXmlEscapes(s: string): string {
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

/** True if `text` looks like it contains CLIXML at all — callers use this to decide whether stripping is even needed. */
export function looksLikeCliXml(text: string): boolean {
  return text.includes('#< CLIXML') || text.includes('<Objs ') || text.includes('<Objs>')
}

/**
 * Extracts a human-readable message from a CLIXML blob, falling back to a
 * generic notice (never the raw XML) if nothing usable could be pulled
 * out. Deliberately a regex scrape, not a full XML parser — consistent
 * with this project's existing "simple format, simple parser" choices
 * (e.g. apps/catalog.ts's VDF parsing) since CLIXML's `<S>` string-element
 * structure is simple and well-known, and a malformed/partial blob should
 * degrade to the fallback rather than throw.
 */
export function stripCliXml(text: string): string {
  if (!looksLikeCliXml(text)) return text.trim()

  const stringElements = [...text.matchAll(/<S[^>]*>([\s\S]*?)<\/S>/g)]
    .map((m) => decodeCliXmlEscapes(m[1]).trim())
    .filter((s) => s.length > 0)

  if (stringElements.length === 0) {
    return 'PowerShell reported an error (see jarvis.log for the full detail).'
  }

  // The first non-empty <S> element is consistently the actual exception
  // message in PowerShell's ErrorRecord serialization; later ones are
  // typically the exception type name, category info, and stack-trace-ish
  // detail that's noise for a spoken/UI-facing summary but stays available
  // in the full raw text this function's caller logs separately.
  return stringElements[0].replace(/\s+/g, ' ').slice(0, 300)
}
