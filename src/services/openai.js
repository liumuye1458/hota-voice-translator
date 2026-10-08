// src/services/openai.js — v3.0
//
// Pure async wrappers around the OpenAI HTTP API. Every function accepts an
// AbortSignal. Errors are thrown as OpenAIHTTPError carrying {status, code}
// so core/modelRouter.js can classify them (PRD-002 §5.1).
//
// TTS lives in core/ttsProvider.js (ADR-004).

import { DEFAULT_TRANSLATION_MODEL, DEFAULT_STT_MODEL } from '../core/modelRouter.js'

const OPENAI_API = 'https://api.openai.com/v1'

export class OpenAIHTTPError extends Error {
  constructor({ status, code = null, param = null, message, model }) {
    super(message)
    this.name = 'OpenAIHTTPError'
    this.status = status
    this.code = code
    this.param = param
    this.model = model
  }
}

async function throwFromResponse(res, model, label) {
  const data = await res.json().catch(() => ({}))
  throw new OpenAIHTTPError({
    status: res.status,
    code: data.error?.code || null,
    param: data.error?.param || null,
    message: data.error?.message || `${label} HTTP ${res.status}`,
    model
  })
}

// GPT-6 models reject a non-default temperature ("Only the default (1) value
// is supported"). Found by the 2026-10-08 golden eval.
function supportsTemperature(model) {
  return !/^gpt-6/.test(model)
}

// ===== Translation =====================================================

/**
 * Translate text from sourceLang to targetLang.
 *
 * Includes an output-language sanity check: if the result is not in the
 * expected target language, retries ONCE (same model) with an emphatic prefix.
 * Model fallback across models is NOT done here — see core/modelRouter.js.
 *
 * @returns {Promise<string>}
 */
export async function translateText(text, sourceLang, targetLang, apiKey, customInstructions = '', signal, model = DEFAULT_TRANSLATION_MODEL) {
  let result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 0, signal, model)
  if (isWrongLanguage(result, targetLang)) {
    console.warn('[translate] output language mismatch, retrying:', result)
    result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 1, signal, model)
  }
  return result
}

function buildSystemPrompt(sourceLang, targetLang, customInstructions, attempt) {
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
  return systemPrompt
}

async function callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, attempt, signal, model) {
  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      ...(supportsTemperature(model) ? { temperature: 0 } : {}),
      messages: [
        { role: 'system', content: buildSystemPrompt(sourceLang, targetLang, customInstructions, attempt) },
        { role: 'user', content: text }
      ]
    }),
    signal
  })
  if (!res.ok) await throwFromResponse(res, model, 'Translation')
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

// ===== Model probe (Settings "检测可用模型") ============================

/**
 * Minimal chat call to check whether this key can use a model.
 * @returns {Promise<{ok: boolean, status: number|null, message: string}>}
 */
export async function probeModel(model, apiKey, signal) {
  try {
    const res = await fetch(`${OPENAI_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }] }),
      signal
    })
    if (res.ok) return { ok: true, status: res.status, message: '' }
    const data = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, message: data.error?.message || `HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, status: null, message: err?.message || 'network error' }
  }
}

// ===== STT =============================================================

/**
 * Transcribe an audio blob.
 *
 * @param {string} lang — ISO 639-1 ('id', 'zh', ...). Empty = autodetect.
 * @param {string} prompt — bias text (names, jargon, currency formats)
 * @param {string} model — 'gpt-4o-transcribe' | 'gpt-transcribe'
 * @returns {Promise<string>}
 */
export async function transcribeAudio(audioBlob, mimeType, lang, prompt, apiKey, signal, model = DEFAULT_STT_MODEL) {
  if (!audioBlob || audioBlob.size < 200) return ''

  const formData = new FormData()
  formData.append('file', audioBlob, `audio.${mimeTypeToExt(mimeType)}`)
  formData.append('model', model)
  if (lang) formData.append('language', lang)
  if (prompt && prompt.trim()) formData.append('prompt', prompt.trim())

  const res = await fetch(`${OPENAI_API}/audio/transcriptions`, {
    method: 'POST',
    // No Content-Type: fetch sets the multipart boundary
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
    signal
  })
  if (!res.ok) await throwFromResponse(res, model, 'Transcribe')
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
