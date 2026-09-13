import { z } from 'zod'
import type { JarvisTool } from './registry'
import { captureScreen } from '../perception/capture'

export const lookAtScreenTool: JarvisTool = {
  name: 'look_at_screen',
  description:
    'Take a screenshot to actually see the current screen — use this whenever Weston references something visual you can\'t know from conversation alone: "look at this", "what\'s this error?", "look where my mouse is", "do you see what I mean?". Captures only when called, never continuously.',
  risk: 'safe',
  input: z.object({
    focus: z
      .enum(['full', 'active_window', 'cursor'])
      .describe('"active_window" for the frontmost app (most requests), "cursor" for a close-up around the mouse pointer, "full" for the whole screen.'),
    question: z.string().optional().describe("What you're trying to answer, e.g. \"what does this error say?\" — helps you look at the right thing, not sent anywhere else.")
  }),
  run: async (input) => {
    const capture = await captureScreen(input.focus)
    return {
      ok: true,
      message: input.question ? `Here's what's on screen (${input.focus}) to answer: ${input.question}` : `Here's what's on screen (${input.focus}).`,
      images: [{ mediaType: capture.mediaType, base64: capture.base64 }]
    }
  }
}
