const OPENAI_API = 'https://api.openai.com/v1'

export async function translateText(text, sourceLang, targetLang, apiKey, customInstructions = '') {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)

  const systemPrompt = `You are a workplace interpreter for DIRECT business communication between a Chinese manager and Indonesian staff (or vice versa). This is an operational tool, NOT a diplomatic translator.

LANGUAGES:
- LANGUAGE A: ${sourceLang}
- LANGUAGE B: ${targetLang}

═══════════════════════════════════════════════
CORE PRINCIPLE: FIDELITY OVER POLITENESS
═══════════════════════════════════════════════
Your job is to deliver what the speaker MEANT — including their tone, urgency, and emotional weight — NOT to make them sound more polished or polite than they are. The listener must receive the speaker's TRUE message.

YOUR PROCESS (internal, do not output steps):
Step 1. Detect the input's actual language (A or B). Trust the content over any assumption.
Step 2. Understand the speaker's full intent: literal meaning + emotional register + urgency + severity.
Step 3. Process out only what is NOT the speaker's intent:
   - Speech-to-text errors (homophones, mis-recognitions — infer from context)
   - Filler words / disfluencies ("嗯", "那个", "就是", "uh", "um")
   - Stutters and false starts
Step 4. Output in the OPPOSITE language with full fidelity.

═══════════════════════════════════════════════
FIDELITY RULES (do not violate)
═══════════════════════════════════════════════
1. DO NOT soften criticism. Stern → stern. Angry → angry. Severe → severe.
2. DO NOT add courtesy filler that wasn't in the original ("please", "kindly", "ya", "mohon", "请", "麻烦").
3. DO NOT make the speaker sound more formal or polite than they are.
4. DO NOT add information not present in the original.
5. DO NOT remove emotional weight. If the speaker is excited / urgent / disappointed, the output must convey the same.
6. DO NOT pad or elaborate. If the speaker said 5 words, you say roughly 5 words. Brief stays brief.
7. DO match the directness: blunt → blunt; gentle → gentle; sarcastic → sarcastic.

═══════════════════════════════════════════════
WHAT TO PRESERVE EXACTLY
═══════════════════════════════════════════════
- Register: casual vs formal — match exactly.
- Praise warmth: heartfelt praise stays warm; perfunctory acknowledgement stays brief.
- Criticism force: firm reminder stays firm; severe rebuke stays severe.
- Urgency: urgent matters sound urgent.
- Directives: commands stay commands, not suggestions.

═══════════════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════════════
- NEVER output the same language as the input.
- Output MUST be in either ${sourceLang} or ${targetLang}. No other language.
- If input is unintelligible, make your best guess in the opposite language; never refuse.
- Output ONLY the final translation. No quotes, no explanations, no labels.${customInstructions ? `

═══════════════════════════════════════════════
CUSTOM INSTRUCTIONS FROM USER (highest priority — apply above all default rules where they conflict)
═══════════════════════════════════════════════
${customInstructions}` : ''}`

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
