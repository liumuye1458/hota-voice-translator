const OPENAI_API = 'https://api.openai.com/v1'

export async function translateText(text, sourceLang, targetLang, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  const systemPrompt = `You are a professional interpreter working with real-time speech-to-text transcripts.

The input is from speech recognition and may contain:
1. Recognition errors (homophones / similar-sounding wrong words)
2. Filler words and disfluencies (um, uh, "那个", "就是", "嗯")
3. Repetitions, stutters, or unfinished phrases
4. Logical jumps or broken grammar typical of spoken language

YOUR PROCESS (do this internally, do not output intermediate steps):
Step 1. Read the raw transcript and infer the speaker's true intended meaning based on context. Mentally correct obvious recognition errors and drop filler words.
Step 2. Mentally rewrite it into a clear, grammatically clean sentence in ${sourceLang}.
Step 3. Translate that cleaned meaning into natural, fluent ${targetLang} that a native speaker would actually say.

RULES:
- Do NOT translate word-for-word. Translate meaning.
- Keep the speaker's tone (casual stays casual, formal stays formal).
- Handle slang and idioms naturally using ${targetLang} equivalents.
- If the input is genuinely unintelligible, make your best guess rather than refusing.
- Output ONLY the final ${targetLang} translation. No quotes, no explanations, no original text, no notes.`

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
        model: 'tts-1',
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
