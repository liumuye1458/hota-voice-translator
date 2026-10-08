// src/core/ttsProvider.js — ADR-004
//
// TTS provider contract (v3.0 defines only kind='blob-url').
//
//   synthesize(request, signal) -> Promise<BlobTTSResult>
//     request: { text, voice, sessionId, ttsQueueId, chunkIndex }
//     result:  { kind: 'blob-url', url, revoke() }   // revoke is idempotent
//   Throws TTSError on failure.
//
// Future result kinds (e.g. a PCM stream for gpt-realtime-*) belong in the
// Realtime TTS ADR, not here. audioEngine rejects unknown kinds explicitly.

const OPENAI_SPEECH_URL = 'https://api.openai.com/v1/audio/speech'

export class TTSError extends Error {
  constructor({ provider, model, status = null, body = null, message }) {
    super(message)
    this.name = 'TTSError'
    this.provider = provider
    this.model = model
    this.status = status
    this.body = body
  }
}

export class OpenAIStandardTTS {
  constructor({ apiKey, model = 'gpt-4o-mini-tts', fetchImpl } = {}) {
    this.apiKey = apiKey
    this.model = model
    this.name = 'openai-standard'
    this._fetch = fetchImpl || ((...a) => fetch(...a))
  }

  async synthesize(req, signal) {
    let res
    try {
      res = await this._fetch(OPENAI_SPEECH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          input: req.text,
          voice: req.voice || 'nova',
          response_format: 'mp3'
        }),
        signal
      })
    } catch (err) {
      if (err?.name === 'AbortError') throw err
      throw new TTSError({ provider: this.name, model: this.model, message: err?.message || 'network error' })
    }

    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500)
      throw new TTSError({
        provider: this.name,
        model: this.model,
        status: res.status,
        body,
        message: `TTS HTTP ${res.status}`
      })
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    let revoked = false
    return {
      kind: 'blob-url',
      url,
      revoke: () => {
        if (revoked) return
        revoked = true
        try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
      }
    }
  }
}
