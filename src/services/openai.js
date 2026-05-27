const OPENAI_API = 'https://api.openai.com/v1'

// Heuristic check: roughly detect if text is "Chinese-dominant" or "non-Chinese-dominant"
function isChineseDominant(text) {
  if (!text) return false
  const chineseChars = (text.match(/[一-鿿]/g) || []).length
  const totalChars = text.replace(/\s/g, '').length || 1
  return chineseChars / totalChars > 0.3
}

// Single direct call to GPT-4o for translation
async function callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, attempt) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  // SHORT, BLUNT prompt. No decorations, no multi-section structure.
  // GPT-4o follows short directive prompts more reliably than elaborate ones.
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

  // On retry, make the language constraint even more emphatic
  if (attempt > 0) {
    systemPrompt = `THE OUTPUT MUST BE WRITTEN IN ${targetLang.toUpperCase()}. NOT ENGLISH. NOT ${sourceLang.toUpperCase()}. ONLY ${targetLang.toUpperCase()}.\n\n` + systemPrompt
  }

  try {
    const response = await fetch(`${OPENAI_API}/chat/completions`, {
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
      signal: controller.signal
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error?.message || `OpenAI error ${response.status}`)
    }

    const data = await response.json()
    return data.choices[0].message.content.trim()
  } finally {
    clearTimeout(timeout)
  }
}

export async function translateText(text, sourceLang, targetLang, apiKey, customInstructions = '') {
  // First attempt
  let result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 0)

  // Sanity check: detect output-language mismatch
  // If we're going Chinese → non-Chinese, result should NOT be Chinese-dominant
  // If we're going non-Chinese → Chinese, result SHOULD be Chinese-dominant
  const sourceIsChinese = sourceLang.toLowerCase().includes('chinese')
  const targetIsChinese = targetLang.toLowerCase().includes('chinese')
  const resultIsChinese = isChineseDominant(result)

  let wrongLanguage = false
  if (targetIsChinese && !resultIsChinese) wrongLanguage = true
  if (!targetIsChinese && resultIsChinese) wrongLanguage = true
  // Heuristic for English-leak when target is Indonesian/Vietnamese/etc:
  // if target is NOT English and NOT Chinese, and result has no Chinese chars
  // but has lots of common English-only words, it's probably English.
  if (!targetIsChinese && !targetLang.toLowerCase().includes('english')) {
    const englishWordHits = (result.match(/\b(the|and|is|are|will|please|tomorrow|product|live|stream)\b/gi) || []).length
    const wordCount = result.split(/\s+/).length || 1
    if (englishWordHits / wordCount > 0.3) wrongLanguage = true
  }

  if (wrongLanguage) {
    console.warn('[translateText] Output language mismatch, retrying:', result)
    result = await callTranslateOnce(text, sourceLang, targetLang, apiKey, customInstructions, 1)
  }

  return result
}

export async function transcribeAudio(audioBlob, lang, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  try {
    const formData = new FormData()
    formData.append('file', audioBlob, 'audio.webm')
    formData.append('model', 'whisper-1')
    if (lang) formData.append('language', lang) // ISO 639-1: 'zh', 'id', 'en', etc.

    const response = await fetch(`${OPENAI_API}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`
      },
      body: formData,
      signal: controller.signal
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error?.message || `Whisper error ${response.status}`)
    }

    const data = await response.json()
    return data.text?.trim() || ''
  } finally {
    clearTimeout(timeout)
  }
}

export async function synthesizeSpeech(text, voice, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(`${OPENAI_API}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'tts-1-hd',
        input: text,
        voice: voice || 'nova',
        response_format: 'mp3'
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error?.message || `TTS error ${response.status}`)
    }

    const blob = await response.blob()
    return URL.createObjectURL(blob)
  } finally {
    clearTimeout(timeout)
  }
}
