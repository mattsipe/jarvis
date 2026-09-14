import { describe, it, expect } from 'vitest'
import { classifyRisk, type RiskContext } from './risk'

function ctx(overrides: Partial<RiskContext>): RiskContext {
  return { intent: '', ...overrides }
}

describe('operate/risk classifyRisk — elevated (consequential) cases', () => {
  it.each([
    ['send an email', { intent: 'send the email', targetName: 'Send' }],
    ['reply all in Outlook', { intent: 'reply all', targetName: 'Reply All' }],
    ['delete a file', { intent: 'delete this file', targetName: 'Delete' }],
    ['buy/checkout', { intent: 'buy this item', targetName: 'Checkout' }],
    ['submit a form', { intent: 'submit the form', targetName: 'Submit' }],
    ['sign out', { intent: 'sign out of Windows', targetName: 'Sign out' }],
    ['restart', { intent: 'restart the computer', targetName: 'Restart' }],
    ['shut down', { intent: 'shut down', targetName: 'Shut down' }],
    ["don't save", { intent: "don't save changes", targetName: "Don't Save" }],
    ['uninstall', { intent: 'uninstall this app', targetName: 'Uninstall' }],
    ['disable Defender', { intent: 'disable Windows Defender', targetName: 'Turn off' }]
  ])('%s -> elevated', (_label, overrides) => {
    expect(classifyRisk(ctx(overrides)).risk).toBe('elevated')
  })

  it('Ctrl+Enter in an Outlook compose window is elevated', () => {
    expect(classifyRisk(ctx({ intent: 'send it', keys: 'Ctrl+Enter', windowTitle: 'Compose - Outlook' })).risk).toBe('elevated')
  })

  it('Shift+Delete is always elevated', () => {
    expect(classifyRisk(ctx({ intent: 'delete permanently', keys: 'Shift+Delete' })).risk).toBe('elevated')
  })

  it('Alt+F4 on a window with an unsaved marker is elevated', () => {
    expect(classifyRisk(ctx({ intent: 'close it', keys: 'Alt+F4', windowTitle: '*Untitled - Notepad' })).risk).toBe('elevated')
  })

  it('an unlabeled icon button inside a checkout window defaults to elevated', () => {
    expect(classifyRisk(ctx({ intent: 'click it', targetRole: 'Button', windowTitle: 'Checkout - Store' })).risk).toBe('elevated')
  })
})

describe('operate/risk classifyRisk — moderate (routine) cases', () => {
  it.each([
    ['toggle Bluetooth', { intent: 'turn on Bluetooth', targetName: 'Bluetooth' }],
    ['toggle Wi-Fi', { intent: 'turn off Wi-Fi', targetName: 'Wi-Fi' }],
    ['type in a search box', { intent: 'search for settings', targetName: 'Search', targetRole: 'Edit' }],
    ['select a list item', { intent: 'select the second result', targetRole: 'ListItem' }],
    ['scroll down', { intent: 'scroll down' }],
    ['expand a tree node', { intent: 'expand the folder', targetRole: 'TreeItem' }]
  ])('%s -> moderate', (_label, overrides) => {
    expect(classifyRisk(ctx(overrides)).risk).toBe('moderate')
  })

  it('Alt+F4 on a window with no unsaved marker is not elevated', () => {
    expect(classifyRisk(ctx({ intent: 'close it', keys: 'Alt+F4', windowTitle: 'Notepad' })).risk).toBe('moderate')
  })

  it('a labeled button inside a checkout window is not auto-elevated by the unlabeled-icon rule (still checked by keyword)', () => {
    expect(classifyRisk(ctx({ intent: 'click cancel', targetName: 'Cancel', windowTitle: 'Checkout - Store' })).risk).toBe('moderate')
  })
})
