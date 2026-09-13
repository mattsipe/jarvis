import { z } from 'zod'
import type { JarvisTool } from './registry'

export const openUrlTool: JarvisTool = {
  name: 'open_url',
  description: 'Open a URL in the default web browser.',
  risk: 'moderate',
  input: z.object({ url: z.string().url().describe('A full URL, including https://.') }),
  run: (input, ctx) => ctx.platform.openUrl(input.url)
}
