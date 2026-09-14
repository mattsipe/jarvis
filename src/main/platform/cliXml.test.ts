import { describe, it, expect } from 'vitest'
import { looksLikeCliXml, stripCliXml } from './cliXml'

const REALISTIC_CLIXML = [
  '#< CLIXML',
  '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">',
  '<S S="Error">This command cannot be run due to the error: The system cannot find the file specified._x000D__x000A_</S>',
  '<S S="Error">    + CategoryInfo          : InvalidOperation: (:) [Start-Process], InvalidOperationException_x000D__x000A_</S>',
  '<S S="Error">    + FullyQualifiedErrorId : InvalidOperationException,Microsoft.PowerShell.Commands.StartProcessCommand_x000D__x000A_</S>',
  '</Objs>'
].join('')

describe('platform/cliXml looksLikeCliXml', () => {
  it('recognizes the "#< CLIXML" marker', () => {
    expect(looksLikeCliXml(REALISTIC_CLIXML)).toBe(true)
  })

  it('recognizes bare <Objs> without the marker line', () => {
    expect(looksLikeCliXml('<Objs Version="1.1.0.1"><S>hi</S></Objs>')).toBe(true)
  })

  it('returns false for ordinary plain-text error output', () => {
    expect(looksLikeCliXml('The system cannot find the file specified.')).toBe(false)
  })
})

describe('platform/cliXml stripCliXml', () => {
  it('extracts the first, human-readable error message from realistic CLIXML', () => {
    expect(stripCliXml(REALISTIC_CLIXML)).toBe('This command cannot be run due to the error: The system cannot find the file specified.')
  })

  it('decodes _xHHHH_ escapes (CRLF and otherwise) instead of leaving them literal', () => {
    const result = stripCliXml(REALISTIC_CLIXML)
    expect(result).not.toContain('_x000D_')
    expect(result).not.toContain('_x000A_')
  })

  it('never returns raw XML tags to the caller', () => {
    const result = stripCliXml(REALISTIC_CLIXML)
    expect(result).not.toMatch(/<[^>]+>/)
  })

  it('passes plain (non-CLIXML) text through unchanged, just trimmed', () => {
    expect(stripCliXml('  plain error text  ')).toBe('plain error text')
  })

  it('falls back to a generic notice when CLIXML is detected but no <S> content can be extracted', () => {
    expect(stripCliXml('#< CLIXML\n<Objs></Objs>')).toMatch(/PowerShell reported an error/)
  })

  it('truncates a very long extracted message rather than flooding the UI', () => {
    const longXml = `#< CLIXML\n<Objs><S S="Error">${'x'.repeat(1000)}</S></Objs>`
    expect(stripCliXml(longXml).length).toBeLessThanOrEqual(300)
  })
})
