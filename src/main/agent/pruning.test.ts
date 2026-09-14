import { describe, it, expect } from 'vitest'
import type Anthropic from '@anthropic-ai/sdk'
import { stubOlderEphemeralResults, capResultLength, EPHEMERAL_TOOL_NAMES } from './pruning'

function userMsg(blocks: Array<{ type: 'tool_result'; tool_use_id: string; content: string }>): Anthropic.MessageParam {
  return { role: 'user', content: blocks as unknown as Anthropic.ContentBlockParam[] }
}

describe('agent/pruning EPHEMERAL_TOOL_NAMES', () => {
  it('includes the expected "look, do not remember" tools', () => {
    for (const name of ['ui_inspect', 'ui_wait', 'look_at_screen', 'find_app', 'recall_memory', 'system_status']) {
      expect(EPHEMERAL_TOOL_NAMES.has(name)).toBe(true)
    }
  })

  it('does not include durable action tools', () => {
    for (const name of ['ui_act', 'keyboard_act', 'open_app', 'open_settings_page']) {
      expect(EPHEMERAL_TOOL_NAMES.has(name)).toBe(false)
    }
  })
})

describe('agent/pruning stubOlderEphemeralResults', () => {
  it('keeps the latest ephemeral result and stubs earlier ones', () => {
    const names = new Map([
      ['t1', 'ui_inspect'],
      ['t2', 'ui_inspect']
    ])
    const messages: Anthropic.MessageParam[] = [
      userMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'first inspect: 40 elements...' }]),
      userMsg([{ type: 'tool_result', tool_use_id: 't2', content: 'second inspect: 12 elements...' }])
    ]
    stubOlderEphemeralResults(messages, names)
    expect((messages[0].content as Anthropic.ToolResultBlockParam[])[0].content).toContain('omitted')
    expect((messages[1].content as Anthropic.ToolResultBlockParam[])[0].content).toBe('second inspect: 12 elements...')
  })

  it('never touches durable tool results', () => {
    const names = new Map([
      ['t1', 'ui_act'],
      ['t2', 'ui_act']
    ])
    const messages: Anthropic.MessageParam[] = [
      userMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'Toggled Bluetooth — verified (On).' }]),
      userMsg([{ type: 'tool_result', tool_use_id: 't2', content: 'Toggled Bluetooth — verified (Off).' }])
    ]
    stubOlderEphemeralResults(messages, names)
    expect((messages[0].content as Anthropic.ToolResultBlockParam[])[0].content).toBe('Toggled Bluetooth — verified (On).')
    expect((messages[1].content as Anthropic.ToolResultBlockParam[])[0].content).toBe('Toggled Bluetooth — verified (Off).')
  })

  it('handles an unknown tool_use_id gracefully (no name recorded)', () => {
    const messages: Anthropic.MessageParam[] = [userMsg([{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }])]
    expect(() => stubOlderEphemeralResults(messages, new Map())).not.toThrow()
    expect((messages[0].content as Anthropic.ToolResultBlockParam[])[0].content).toBe('x')
  })

  it('keeps the most recent of each distinct ephemeral tool independently', () => {
    const names = new Map([
      ['a1', 'ui_inspect'],
      ['a2', 'look_at_screen'],
      ['a3', 'ui_inspect']
    ])
    const messages: Anthropic.MessageParam[] = [
      userMsg([{ type: 'tool_result', tool_use_id: 'a1', content: 'inspect 1' }]),
      userMsg([{ type: 'tool_result', tool_use_id: 'a2', content: 'screen 1' }]),
      userMsg([{ type: 'tool_result', tool_use_id: 'a3', content: 'inspect 2' }])
    ]
    stubOlderEphemeralResults(messages, names)
    expect((messages[0].content as Anthropic.ToolResultBlockParam[])[0].content).toContain('omitted')
    expect((messages[1].content as Anthropic.ToolResultBlockParam[])[0].content).toBe('screen 1') // only ephemeral call of its kind — stays
    expect((messages[2].content as Anthropic.ToolResultBlockParam[])[0].content).toBe('inspect 2')
  })
})

describe('agent/pruning capResultLength', () => {
  it('leaves short text alone', () => {
    expect(capResultLength('short')).toBe('short')
  })

  it('caps long text with a count of remaining characters', () => {
    const text = 'a'.repeat(2000)
    const capped = capResultLength(text, 1500)
    expect(capped.startsWith('a'.repeat(1500))).toBe(true)
    expect(capped).toContain('+500 more chars')
  })
})
