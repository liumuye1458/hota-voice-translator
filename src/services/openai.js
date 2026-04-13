const OPENAI_API = 'https://api.openai.com/v1'

export async function translateText(text, sourceLang, targetLang, apiKey) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  const systemPrompt = `You are a professional translator. Translate the following text from ${sourceLang} to ${targetLang}.
Keep translations natural and conversational. Handle slang naturally.
Respond ONLY with the translated text, nothing else. No quotes, no explanation.`

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
