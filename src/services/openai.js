// src/services/openai.js — v3.0
//
// Pure async wrappers around the OpenAI HTTP API. Every function accepts an
// AbortSignal. Errors are thrown as OpenAIHTTPError carrying {status, code}
// so core/modelRouter.js can classify them (PRD-002 §5.1).
//
// TTS lives in core/ttsProvider.js (ADR-004).

import { DEFAULT_TRANSLATION_MODEL, UPLOAD_STT_FALLBACK, translationParams } from '../core/modelRouter.js'
import { createFirstSentenceSplitter } from '../core/streamChunker.js'
import { DOMAIN_PROMPT } from '../config/domainPrompt.js'

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

/**
 * Streaming translation (PRD-003 §3.1). Calls onChunk(text) with the first
 * complete sentence as soon as it arrives, then once more with the remainder
 * when the stream ends — so TTS can start before the whole translation exists.
 *
 * The first sentence passes the same output-language check as translateText();
 * on mismatch the stream is dropped and the emphatic non-streaming retry runs
 * (nothing has been spoken yet at that point).
 *
 * HTTP errors are thrown before any onChunk call, so model routing (retry /
 * fallback) stays safe to wrap around this.
 *
 * @returns {Promise<string>} the full translation
 */
export async function translateTextStream(text, sourceLang, targetLang, apiKey, customInstructions = '', signal, model = DEFAULT_TRANSLATION_MODEL, onChunk = () => {}, timeouts = STREAM_TIMEOUTS) {
  const local = new AbortController()
  const onAbort = () => local.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  // Watchdog: a stream that stops sending bytes without closing would hang
  // the turn forever (stuck in TRANSLATING / SPEAKING).
  let stalled = false
  let watchdog = null
  const arm = (ms) => {
    clearTimeout(watchdog)
    watchdog = setTimeout(() => { stalled = true; local.abort() }, ms)
  }
  arm(timeouts.firstByteMs)

  try {
    const res = await postChat(apiKey, () => chatBody(text, sourceLang, targetLang, customInstructions, 0, model, true), local.signal, model)

    const splitter = createFirstSentenceSplitter()
    const stream = { done: false }
    let full = ''
    let emitted = 0
    for await (const delta of readChatDeltas(res.body, stream, () => arm(timeouts.idleMs))) {
      full += delta
      if (emitted) continue
      const first = splitter.push(full)
      if (!first) continue
      if (isWrongLanguage(first, targetLang)) {
        local.abort()
        return await retryEmphatic(full)
      }
      onChunk(first)
      emitted = first.length
    }
    clearTimeout(watchdog)

    // EOF without [DONE] = connection dropped mid-answer: never present a
    // truncated translation as complete (it may cut off a negation/amount).
    if (!stream.done) {
      throw new OpenAIHTTPError({ status: null, message: '翻译连接中断，译文不完整', model })
    }

    full = full.trim()
    if (!emitted) {
      if (isWrongLanguage(full, targetLang)) return await retryEmphatic(full)
      if (full) onChunk(full)
      return full
    }
    const rest = full.slice(emitted).trim()
    if (rest) onChunk(rest)
    return full
  } catch (err) {
    if (stalled && !signal?.aborted) {
      throw new OpenAIHTTPError({ status: null, message: '翻译超时：网络长时间无响应', model })
    }
    throw err
  } finally {
    clearTimeout(watchdog)
    signal?.removeEventListener('abort', onAbort)
  }

  async function retryEmphatic(bad) {
    clearTimeout(watchdog)   // the retry is a separate, non-streaming request
    console.warn('[translate] output language mismatch, retrying:', bad)
    const result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 1, signal, model)
    if (result) onChunk(result)
    return result
  }
}

// Stream deadlines: first byte (covers queueing), then max silence between chunks.
const STREAM_TIMEOUTS = Object.freeze({ firstByteMs: 15000, idleMs: 8000 })

// Yields content deltas from a chat-completions SSE body. Sets state.done on
// [DONE]; throws on an in-stream error event; calls onActivity per network read.
async function* readChatDeltas(body, state, onActivity) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onActivity?.()
    buf += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') {
        state.done = true
        try { await reader.cancel() } catch { /* ignore */ }
        return
      }
      let json
      try { json = JSON.parse(data) } catch { continue }
      if (json.error) {
        throw new OpenAIHTTPError({ status: null, code: json.error.code || null, message: json.error.message || 'stream error' })
      }
      const delta = json.choices?.[0]?.delta?.content
      if (delta) yield delta
    }
  }
}

// Set once an account rejects service_tier; later requests omit it.
let serviceTierRejected = false

/** Test hook: forget a previous service_tier rejection. */
export function _resetServiceTierForTests() { serviceTierRejected = false }

// POST a chat completion; if the account rejects service_tier, drop it and retry
// once so the priority tier can never break translation. Throws OpenAIHTTPError.
async function postChat(apiKey, makeBody, signal, model) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = makeBody()
    const res = await fetch(`${OPENAI_API}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal
    })
    if (res.ok) return res
    const data = await res.json().catch(() => ({}))
    const err = new OpenAIHTTPError({
      status: res.status,
      code: data.error?.code || null,
      param: data.error?.param || null,
      message: data.error?.message || `Translation HTTP ${res.status}`,
      model
    })
    const tierProblem = body.service_tier && res.status === 400 &&
      (err.param === 'service_tier' || /service_tier|service tier/i.test(err.message))
    if (!tierProblem || attempt > 0) throw err
    console.warn('[translate] service_tier rejected, retrying without it:', err.message)
    serviceTierRejected = true
  }
}

function chatBody(text, sourceLang, targetLang, customInstructions, attempt, model, stream = false) {
  const params = { ...translationParams(model) }
  if (serviceTierRejected) delete params.service_tier
  return {
    model,
    ...params,
    ...(stream ? { stream: true } : {}),
    messages: [
      { role: 'system', content: buildSystemPrompt(sourceLang, targetLang, customInstructions, attempt) },
      { role: 'user', content: text }
    ]
  }
}

function buildSystemPrompt(sourceLang, targetLang, customInstructions, attempt) {
  let systemPrompt = `Translate the user's message from ${sourceLang} to ${targetLang}.

Rules:
- Output MUST be in ${targetLang}. Do not output ${sourceLang}. Do not output English unless ${targetLang} IS English.
- The input is a speech-to-text transcript; silently drop filler words ("嗯", "那个", "就是", "uh") and fix obvious mis-recognitions.
- Preserve the speaker's tone exactly. Do not soften criticism. Do not add politeness words that weren't in the original.
- Do not pad. Brief input → brief output.
- Output ONLY the translation. No quotes, no explanation, no labels.`

  // Business glossary / number rules only make sense for the Indonesian pair
  if (/Indonesian/.test(sourceLang) || /Indonesian/.test(targetLang)) {
    systemPrompt += `\n\n${DOMAIN_PROMPT}`
  }

  if (customInstructions && customInstructions.trim()) {
    systemPrompt += `\n\nAdditional rules from user (highest priority):\n${customInstructions.trim()}`
  }
  if (attempt > 0) {
    systemPrompt = `THE OUTPUT MUST BE WRITTEN IN ${targetLang.toUpperCase()}. NOT ENGLISH. NOT ${sourceLang.toUpperCase()}. ONLY ${targetLang.toUpperCase()}.\n\n` + systemPrompt
  }
  return systemPrompt
}

async function callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, attempt, signal, model) {
  const res = await postChat(apiKey, () => chatBody(text, sourceLang, targetLang, customInstructions, attempt, model), signal, model)
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

// ===== Realtime client secret (ADR-005) =================================

/**
 * Exchange the user's API key for a short-lived Realtime client secret.
 * The endpoint allows browser CORS; the long-lived key never goes into a
 * WebSocket. Secrets are reusable until expiry (verified 2026-10-27).
 *
 * @param {object} session  Realtime session config ({type:'transcription', ...})
 * @returns {Promise<{value: string, expiresAt: number}>} expiresAt in ms epoch
 */
export async function mintRealtimeClientSecret(apiKey, session, signal) {
  const res = await fetch(`${OPENAI_API}/realtime/client_secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ session }),
    signal
  })
  if (!res.ok) await throwFromResponse(res, session?.audio?.input?.transcription?.model || 'realtime', 'Realtime secret')
  const data = await res.json()
  if (!data.value) throw new OpenAIHTTPError({ status: res.status, message: 'Realtime secret missing in response', model: 'realtime' })
  return { value: data.value, expiresAt: (data.expires_at || 0) * 1000 }
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
export async function transcribeAudio(audioBlob, mimeType, lang, prompt, apiKey, signal, model = UPLOAD_STT_FALLBACK) {
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
