import { z } from 'zod'
import type { JarvisTool } from './registry'
import type { MemoryKind } from '../context/memory'

const KIND_ENUM = ['preference', 'person', 'project', 'routine', 'device', 'task', 'fact', 'learned'] as const

export const rememberTool: JarvisTool = {
  name: 'remember',
  description:
    'Save a durable fact, preference, or piece of context about Weston for future conversations and restarts. Use whenever he tells you to remember something or states a lasting preference. For which specific installed app a name like "Outlook" should mean, use set_app_preference instead — never remember (a preference saved here is prose for conversation, not something that gets launched).',
  risk: 'safe',
  input: z.object({
    kind: z
      .enum(KIND_ENUM)
      .describe(
        '"preference" for how Weston wants something done, "person"/"project"/"routine"/"device" for those, "fact" for anything else durable.'
      ),
    subject: z.string().describe('What this is about, e.g. "Outlook", "Steam", a person\'s name, a project name.'),
    content: z.string().describe('The actual fact/value/preference to remember.')
  }),
  run: async (input, ctx) => {
    const record = ctx.context.memory.upsert({
      kind: input.kind as MemoryKind,
      subject: input.subject,
      content: input.content,
      source: 'explicit'
    })
    return { ok: true, message: `Remembered: ${input.subject} — ${input.content}.`, data: { id: record.id } }
  }
}

export const recallMemoryTool: JarvisTool = {
  name: 'recall_memory',
  description:
    'Search what you remember about Weston — preferences, people, projects, routines, past facts. Use this when he asks "what did I tell you about X" or to check something not already in your always-on memory summary.',
  risk: 'safe',
  input: z.object({ query: z.string().describe('What to search for, e.g. "Outlook" or "birthday".') }),
  run: async (input, ctx) => {
    const matches = ctx.context.memory.recall(input.query)
    if (matches.length === 0) return { ok: false, message: `Nothing remembered about "${input.query}".` }
    return {
      ok: true,
      message: matches.map((m) => `${m.subject}: ${m.content}`).join(' | '),
      data: { matches: matches.map((m) => ({ id: m.id, kind: m.kind, subject: m.subject, content: m.content })) }
    }
  }
}

export const updateMemoryTool: JarvisTool = {
  name: 'update_memory',
  description: 'Change the content of an existing memory. Call recall_memory first to get its id.',
  risk: 'safe',
  input: z.object({ id: z.string(), content: z.string() }),
  run: async (input, ctx) => {
    const updated = ctx.context.memory.update(input.id, { content: input.content })
    if (!updated) return { ok: false, message: `No memory with id ${input.id} — search with recall_memory first.` }
    return { ok: true, message: `Updated: ${updated.subject} — ${updated.content}.` }
  }
}

export const forgetMemoryTool: JarvisTool = {
  name: 'forget_memory',
  description:
    "Delete a memory. If you don't already have its id, call recall_memory first — if more than one result could match what Weston means, ask which one before calling this.",
  risk: 'safe',
  input: z.object({ id: z.string() }),
  run: async (input, ctx) => {
    const removed = ctx.context.memory.remove(input.id)
    return { ok: removed, message: removed ? 'Forgotten.' : `No memory with id ${input.id}.` }
  }
}
