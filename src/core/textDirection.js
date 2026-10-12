// src/core/textDirection.js — DEC-2026-10-12-text-input-auto-direction
//
// Decide which way typed/pasted text should be translated.
// Chinese-dominant (> 30% Han characters, same threshold as the output-language
// check in services/openai.js) → 'zh→id'; anything else → 'id→zh'.

const HAN = /[㐀-䶿一-鿿豈-﫿]/g

export function detectTextDirection(text) {
  const compact = (text || '').replace(/\s/g, '')
  if (!compact) return 'zh→id'
  const han = (compact.match(HAN) || []).length
  return han / compact.length > 0.3 ? 'zh→id' : 'id→zh'
}
