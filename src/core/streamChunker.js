// src/core/streamChunker.js — PRD-003 §3.1
//
// Finds the first complete sentence in a translation that is still streaming,
// so TTS can start on it while the rest is generated.
//
// A sentence is complete when a sentence-end mark is followed by more text:
//   - Chinese 。！？ (anything may follow)
//   - Western . ! ? followed by whitespace — "Rp1.500.000", "12.5", "3.14" never split
//   - A newline
// We also require at least MIN_CHARS before the boundary so a lone "Pak." or
// "好。" does not cost an extra TTS round trip.

const MIN_CHARS = 8
const BOUNDARY = /[。！？]+|[.!?]+(?=\s)|\n+/g

/**
 * @returns {{ push(textSoFar: string): string|null }}
 *   push() returns the first sentence (trimmed) the first time one is
 *   complete, null before that, and null forever after.
 */
export function createFirstSentenceSplitter() {
  let done = false
  return {
    push(textSoFar) {
      if (done) return null
      const s = String(textSoFar || '')
      BOUNDARY.lastIndex = 0
      for (const m of s.matchAll(BOUNDARY)) {
        const end = m.index + m[0].length
        const head = s.slice(0, end).trim()
        if (head.length < MIN_CHARS) continue
        // Need something after the mark, otherwise the stream may still be
        // inside a number or abbreviation ("Rp1." → "Rp1.500").
        if (!s.slice(end).trim()) return null
        done = true
        return head
      }
      return null
    }
  }
}
