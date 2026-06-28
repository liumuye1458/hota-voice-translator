// src/services/openai.js — v2.0
//
// Pure async wrappers around OpenAI HTTP API.
// Every function accepts an AbortSignal so the caller can cancel.
//
// CRITICAL: these functions know NOTHING about state, sessions, or React.
// They are pure I/O. The session manager owns the abort controllers.

const OPENAI_API = 'https://api.openai.com/v1'

// ===== Translation =====================================================

/**
 * Translate text from sourceLang to targetLang via gpt-4o.
 *
 * Includes output-language sanity check: if the result is not in the
 * expected target language, retries ONCE with an emphatic prompt prefix.
 *
 * @param {string} text
 * @param {string} sourceLang — "Chinese (Simplified, 简体中文)" form
 * @param {string} targetLang — same form
 * @param {string} apiKey
 * @param {string} customInstructions — optional company-specific rules
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
export async function translateText(text, sourceLang, targetLang, apiKey, customInstructions = '', signal) {
  let result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 0, signal)
  if (isWrongLanguage(result, targetLang)) {
    console.warn('[translate] output language mismatch, retrying:', result)
    result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 1, signal)
  }
  return result
}

async function callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, attempt, signal) {
  let systemPrompt = `Translate the user's message from ${sourceLang} to ${targetLang}.

Rules:
- Output MUST be in ${targetLang}. Do not output ${sourceLang}. Do not output English unless ${targetLang} IS English.
- The input is a speech-to-text transcript; silently drop filler words ("嗯", "那个", "就是", "uh") and fix obvious mis-recognitions.
- Preserve the speaker's tone exactly. Do not soften criticism. Do not add politeness words that weren't in the original.
- Do not pad. Brief input → brief output.
- Output ONLY the translation. No quotes, no explanation, no labels.`

  if (customInstructions && customInstructions.trim()) {
    systemPrompt += `\n\nAdditional rules from user (highest priority):\n${customInstructions.trim()}`
  }
  if (attempt > 0) {
    systemPrompt = `THE OUTPUT MUST BE WRITTEN IN ${targetLang.toUpperCase()}. NOT ENGLISH. NOT ${sourceLang.toUpperCase()}. ONLY ${targetLang.toUpperCase()}.\n\n` + systemPrompt
  }

  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    }),
    signal
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Translation HTTP ${res.status}`)
  }
  const data = await res.json()
  return data.choices[0].message.content.trim()
}

function isChineseDominant(text) {
  if (!text) return false
  const cn = (text.match(/[一-鿿]/g) || []).length
  const total = text.replace(/\s/g, '').length || 1
  return cn / total > 0.3
}

function isWrongLanguage(result, targetLang) {
  const targetLower = targetLang.toLowerCase()
  const targetIsChinese = targetLower.includes('chinese') || targetLower.includes('中文')
  const targetIsEnglish = targetLower.includes('english')
  const resultIsChinese = isChineseDominant(result)
  if (targetIsChinese && !resultIsChinese) return true
  if (!targetIsChinese && resultIsChinese) return true
  if (!targetIsChinese && !targetIsEnglish) {
    const englishHits = (result.match(/\b(the|and|is|are|will|please|tomorrow|product|live|stream)\b/gi) || []).length
    const wordCount = result.split(/\s+/).length || 1
    if (englishHits / wordCount > 0.3) return true
  }
  return false
}

// ===== TTS =============================================================

/**
 * Synthesize one text chunk to an MP3 blob URL.
 *
 * NB: returns a blob URL — caller is responsible for revoking it
 * (typically via Session.trackBlobUrl() which auto-revokes on session.cancel()).
 *
 * @param {string} text — must be ≤ 4096 chars (chunker ensures this)
 * @param {string} voice — 'nova', 'alloy', 'echo', 'fable', 'onyx', 'shimmer'
 * @param {string} apiKey
 * @param {AbortSignal} signal
 * @returns {Promise<string>} blob URL
 */
export async function synthesizeSpeech(text, voice, apiKey, signal) {
  const res = await fetch(`${OPENAI_API}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: voice || 'nova',
      response_format: 'mp3'
    }),
    signal
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `TTS HTTP ${res.status}`)
  }
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

// ===== STT (Whisper / gpt-4o-transcribe) ===============================

/**
 * Transcribe an audio blob using gpt-4o-transcribe.
 *
 * @param {Blob} audioBlob
 * @param {string} mimeType — e.g. 'audio/webm;codecs=opus' (for filename hint)
 * @param {string} lang — ISO 639-1 ('id', 'zh', 'en', ...). Empty string = autodetect.
 * @param {string} prompt — bias text (names, jargon, currency formats, etc.)
 * @param {string} apiKey
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
export async function transcribeAudio(audioBlob, mimeType, lang, prompt, apiKey, signal) {
  if (!audioBlob || audioBlob.size < 200) {
    return '' // No meaningful audio
  }
  // Pick a filename hint that hints at format (OpenAI uses extension for format detection)
  const ext = mimeTypeToExt(mimeType)
  const filename = `audio.${ext}`

  const formData = new FormData()
  formData.append('file', audioBlob, filename)
  formData.append('model', 'gpt-4o-transcribe')
  if (lang) formData.append('language', lang)
  if (prompt && prompt.trim()) formData.append('prompt', prompt.trim())
  // Note: gpt-4o-transcribe doesn't currently support `stream: true` for browser fetch
  // (would need SSE handling). Plain JSON response is fine for v2.0.

  const res = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      // NB: do NOT set Content-Type — let fetch set the multipart boundary
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData,
    signal
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Transcribe HTTP ${res.status}`)
  }
  const data = await res.json()
  return (data.text || '').trim()
}

function mimeTypeToExt(mimeType) {
  if (!mimeType) return 'webm'
  if (mimeType.includes('webm')) return 'webm'
  if (mimeType.includes('mp4')) return 'm4a'
  if (mimeType.includes('mp3') || mimeType.includes('mpeg')) return 'mp3'
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  return 'webm'
}

// ===== Aliases / re-exports (compat with v1 modules during cutover) ====

export { transcribeAudio as transcribe }
