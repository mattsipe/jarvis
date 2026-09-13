import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config'
import { contextManager } from './index'
import type { MemoryKind } from './memory'
import { logInfo, logError } from '../logger'

export interface SessionTurn {
  userText: string
  assistantText: string
}

/** Same rebuild-on-key-change pattern as agent/loop.ts's getClient() — see that file's comment for why. */
let cachedClient: Anthropic | null = null
let cachedKey = ''
function getClient(): Anthropic {
  if (!cachedClient || cachedKey !== config.anthropicApiKey) {
    cachedClient = new Anthropic({ apiKey: config.anthropicApiKey })
    cachedKey = config.anthropicApiKey
  }
  return cachedClient
}

/** Belt-and-suspenders guardrail, checked both before sending the transcript to the extraction model AND on whatever it returns — see learnFromSession(). */
const SENSITIVE_PATTERN =
  /password|secret|api[ _-]?key|credit card|ssn|social security|bank account|routing number|passcode|\bpin\b/i

const VALID_KINDS = new Set<MemoryKind>(['preference', 'person', 'project', 'routine', 'device', 'fact'])

const EXTRACTION_SYSTEM_PROMPT = `You extract durable personal facts from a conversation transcript between Weston and his voice assistant JARVIS, for JARVIS's long-term memory.

Only extract facts that are:
- About Weston himself: his own preferences, people he mentioned, projects he's working on, routines, devices, or facts he stated about himself.
- Clearly durable (still true next week) — a one-off task detail like "open Chrome" is not a fact.

Never extract:
- Passwords, API keys, secret codes, PINs, or any credentials.
- Financial details (account/card numbers, balances) or health information.
- Private information about anyone other than Weston.

When in doubt, leave it out.

Return ONLY a JSON array (empty if nothing qualifies), each item: {"kind": "preference"|"person"|"project"|"routine"|"device"|"fact", "subject": string, "content": string, "confidence": number from 0 to 1}. No other text.`

/**
 * Runs once when a voice session ends (see voice/session.ts's terminate())
 * — not per turn — over that session's own transcript only. Silent, per
 * the confirmed policy: no confirmation prompt, but every guardrail below
 * is a hard skip, not a "lower confidence," and the Command Center Memory
 * panel makes the result auditable after the fact.
 */
export async function learnFromSession(turns: SessionTurn[]): Promise<void> {
  if (turns.length === 0) return
  const transcript = turns.map((t, i) => `Turn ${i + 1}\nWeston: ${t.userText}\nJARVIS: ${t.assistantText}`).join('\n\n')

  if (SENSITIVE_PATTERN.test(transcript)) {
    logInfo('memory:autolearn', 'session transcript matched a sensitive-content pattern — skipped auto-learn entirely.')
    return
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: transcript }]
    })
    const text = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text ?? '[]'
    const jsonMatch = text.match(/\[[\s\S]*\]/)
    if (!jsonMatch) return

    const parsed = JSON.parse(jsonMatch[0]) as Array<{ kind: string; subject?: string; content?: string; confidence?: number }>
    let saved = 0
    for (const item of parsed) {
      if (!VALID_KINDS.has(item.kind as MemoryKind)) continue
      if (!item.subject || !item.content) continue
      if (SENSITIVE_PATTERN.test(`${item.subject} ${item.content}`)) continue
      contextManager.memory.upsert({
        kind: item.kind as MemoryKind,
        subject: item.subject,
        content: item.content,
        source: 'learned',
        confidence: Math.max(0, Math.min(1, item.confidence ?? 0.6))
      })
      saved++
    }
    if (saved > 0) logInfo('memory:autolearn', `learned ${saved} item(s) from this session`)
  } catch (err) {
    logError('memory:autolearn', `extraction failed: ${(err as Error).message}`)
  }
}
