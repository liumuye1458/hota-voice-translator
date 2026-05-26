const OPENAI_API = 'https://api.openai.com/v1'

export async function translateText(text, sourceLang, targetLang, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  const systemPrompt = `You are a professional interpreter for a bilingual conversation between two specific languages:
- LANGUAGE A: ${sourceLang}
- LANGUAGE B: ${targetLang}

The input is from speech recognition and may contain:
1. Recognition errors (homophones / similar-sounding wrong words)
2. Filler words and disfluencies (um, uh, "那个", "就是", "嗯")
3. Repetitions, stutters, or unfinished phrases
4. Broken grammar typical of spoken language

YOUR PROCESS (do this internally, do not output intermediate steps):
Step 1. Detect which of the two languages (A or B) the input is actually in. Speech recognition may have been configured for the wrong language; trust the actual content over any assumption.
Step 2. Read the transcript and infer the speaker's true intended meaning. Mentally correct obvious recognition errors and drop filler words.
Step 3. Determine the OUTPUT language by the opposite-language rule:
   - If input is in LANGUAGE A → output MUST be in LANGUAGE B (${targetLang})
   - If input is in LANGUAGE B → output MUST be in LANGUAGE A (${sourceLang})
Step 4. Translate the cleaned meaning into natural, fluent output that a native speaker would actually say.

ABSOLUTE RULES (violations break the product):
- NEVER output the same language as the input. Translation means changing the language.
- The output MUST be in either ${sourceLang} or ${targetLang}. No other language is allowed.
- If the input mixes both languages, translate the dominant-language portion and produce output in the other language.
- Do NOT translate word-for-word. Translate meaning.
- Keep the speaker's tone (casual stays casual, formal stays formal).
- Handle slang and idioms naturally using equivalents in the output language.
- If the input is genuinely unintelligible, make your best guess in the opposite language rather than refusing.
- Output ONLY the final translation. No quotes, no explanations, no original text, no notes, no language labels.`

  try {
    const response = await fetch(`${OPENAI_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        temperature: 0.3,
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
