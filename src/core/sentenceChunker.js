// src/core/sentenceChunker.js
//
// Splits long text into TTS-friendly chunks at sentence/clause boundaries.
//
// OpenAI Speech API limit: 4096 chars input.
// Our budget: 3200 chars per chunk (margin for UTF-16 edge cases + safety).
//
// Boundary priority (tier 1 wins if any candidate in budget):
//   Tier 1: Chinese sentence-end (。！？) + paragraph break (\n\n)
//   Tier 2: Western sentence-end ". ", "! ", "? " (REQUIRES space → avoids "3.14")
//   Tier 3: Clauses ，,;；
//   Tier 4: Whitespace
//   Tier 5: Hard cut at maxChars (worst case, e.g. one giant URL)

const MAX_CHARS_DEFAULT = 3200

// Each boundary defines (pattern, trailing).
// trailing=true means "cut AFTER the match" (keep the punctuation with the chunk).
// trailing=false means "cut BEFORE the match" (drop the whitespace).
const BOUNDARIES = [
  // Tier 1: Chinese sentence endings and paragraph breaks
  { pattern: /[。！？][\s]*/g, trailing: true },
  { pattern: /\n\n+/g, trailing: false },
  // Tier 2: Western sentence endings — REQUIRES whitespace after to avoid "3.14" / "Inc."
  { pattern: /[.!?]+\s+/g, trailing: true },
  // Tier 3: Clause separators
  { pattern: /[，；,;]\s*/g, trailing: true },
  // Tier 4: Word boundaries (whitespace)
  { pattern: /\s+/g, trailing: false }
]

/**
 * Split text into chunks no larger than maxChars.
 * Each chunk ends at the strongest available boundary within budget.
 *
 * @param {string} text — input text
 * @param {object} options
 * @param {number} options.maxChars — per-chunk character cap (default 3200)
 * @returns {string[]} array of chunks (never empty strings, possibly empty array if input is whitespace-only)
 */
export function split(text, options = {}) {
  const maxChars = options.maxChars ?? MAX_CHARS_DEFAULT

  if (text == null) return []
  const trimmed = String(text).trim()
  if (!trimmed) return []
  if (trimmed.length <= maxChars) return [trimmed]

  const chunks = []
  let remaining = trimmed

  // Hard upper limit on loop iterations as a safety
  const safetyLimit = Math.ceil(trimmed.length / Math.max(1, maxChars - 100)) + 5
  let iter = 0

  while (remaining.length > maxChars) {
    iter += 1
    if (iter > safetyLimit) {
      // Should never happen, but bail rather than infinite loop
      chunks.push(remaining)
      return chunks
    }
    const { chunkText, consumed } = findBestSplit(remaining, maxChars)
    if (!chunkText || consumed <= 0) {
      // Defensive: avoid infinite loop if findBestSplit misbehaves
      chunks.push(remaining.slice(0, maxChars))
      remaining = remaining.slice(maxChars).trim()
      continue
    }
    chunks.push(chunkText)
    remaining = remaining.slice(consumed).trim()
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }
  return chunks
}

function findBestSplit(text, maxChars) {
  for (const { pattern, trailing } of BOUNDARIES) {
    let lastMatch = null
    for (const m of text.matchAll(pattern)) {
      const endPos = m.index + m[0].length
      if (endPos > maxChars) break
      lastMatch = { index: m.index, length: m[0].length }
    }
    if (lastMatch) {
      const cutPoint = trailing
        ? lastMatch.index + lastMatch.length
        : lastMatch.index
      if (cutPoint > 0) {
        return {
          chunkText: text.slice(0, cutPoint).trim(),
          consumed: cutPoint
        }
      }
    }
  }
  // No boundary found in budget → hard cut at maxChars
  return {
    chunkText: text.slice(0, maxChars),
    consumed: maxChars
  }
}
