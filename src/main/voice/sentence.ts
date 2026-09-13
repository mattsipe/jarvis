/**
 * Buffers streamed text deltas and flushes complete sentences as they
 * finish, so TTS can start speaking the first sentence while Claude is
 * still generating the rest — the single biggest perceived-latency win
 * (see the plan's Agent loop section).
 */
export class SentenceChunker {
  private buffer = ''

  /** Feed a text delta; returns any complete sentences newly available. */
  push(delta: string): string[] {
    this.buffer += delta
    const sentences: string[] = []

    // Split on sentence-ending punctuation followed by a space/newline or
    // end of buffer, keeping the punctuation with the sentence.
    let match: RegExpExecArray | null
    const re = /[^.!?]*[.!?]+(?=\s|$)/g
    let lastIndex = 0
    while ((match = re.exec(this.buffer)) !== null) {
      const sentence = match[0].trim()
      if (sentence) sentences.push(sentence)
      lastIndex = re.lastIndex
    }
    this.buffer = this.buffer.slice(lastIndex)
    return sentences
  }

  /** Call when the stream ends — returns any leftover partial text as a final "sentence". */
  flush(): string | null {
    const remaining = this.buffer.trim()
    this.buffer = ''
    return remaining.length > 0 ? remaining : null
  }
}
