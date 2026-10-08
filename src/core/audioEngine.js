// src/core/audioEngine.js
//
// Single owner of: AudioContext lifecycle, persistent <audio> element,
// chunk queue playback with lookahead prefetch, cancellation propagation.
//
// v2.0 strategy:
//   - Persistent <audio> element (NEVER create new ones — Safari loses autoplay perm)
//   - MP3 blob playback as primary path (works everywhere reliably)
//   - PCM + AudioWorklet streaming reserved for v2.1 optimization
//   - All operations gated on session.cancelled + signal.aborted
//
// Events emitted via onEvent callback (caller wires these to FSM dispatch):
//   CHUNK_PLAYING    { sessionId, ttsQueueId, chunkIndex, totalChunks }
//   CHUNK_FAILED     { sessionId, ttsQueueId, chunkIndex, error }
//   SPEAK_PROGRESS   { sessionId, ttsQueueId, chunkIndex, totalChunks }
//   SPEAK_DONE       { sessionId, ttsQueueId }
//   TAP_TO_PLAY      { sessionId, ttsQueueId } — Safari autoplay rejected; UI must show tap-to-play

class AudioEngine {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx = null
    this.unlocked = false
    /** @type {HTMLAudioElement|null} Persistent element reused across chunks */
    this.fallbackAudio = null
    /** @type {Object|null} Current session being played */
    this.currentSession = null
    /** Pending tap-to-play resolver (for Safari autoplay rejection) */
    this._pendingPlayResolve = null
  }

  /**
   * Unlock audio for mobile. MUST be called from a user gesture.
   * Idempotent — safe to call multiple times.
   */
  async unlock() {
    if (this.unlocked) return
    if (typeof window === 'undefined') return // SSR safety

    // Try 24kHz to match OpenAI PCM (avoids resampling when we add streaming)
    try {
      this.ctx = new AudioContext({ sampleRate: 24000 })
    } catch (e) {
      this.ctx = new AudioContext()
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume() } catch (e) { /* ignore */ }
    }

    // iOS silent-buffer poke
    try {
      const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
      const src = this.ctx.createBufferSource()
      src.buffer = buf
      src.connect(this.ctx.destination)
      src.start(0)
    } catch (e) { /* ignore */ }

    // Persistent <audio> element — KEY for Safari autoplay perm
    this.fallbackAudio = document.createElement('audio')
    this.fallbackAudio.preload = 'auto'
    // Don't attach to DOM — audio plays without needing to be visible

    this.unlocked = true
  }

  /**
   * Play a chunk queue for a session.
   *
   * @param {Object} session — Session instance (.id, .cancelled, .trackRevoker, .newTtsQueue)
   * @param {string[]} chunks — array of text chunks (from sentenceChunker)
   * @param {string} voice — TTS voice id
   * @param {{synthesize: Function, name: string}} provider — TTS provider (ADR-004)
   * @param {Function} onEvent — (eventType, payload) => void
   * @returns {Promise<void>} resolves when queue finishes (or aborts)
   */
  async play(session, chunks, voice, provider, onEvent) {
    if (!chunks || chunks.length === 0) {
      onEvent('SPEAK_DONE', { sessionId: session.id, ttsQueueId: -1 })
      return
    }

    // Stop anything currently playing (one queue at a time)
    this._stopPlayback()
    this.currentSession = session

    if (!this.unlocked) await this.unlock()

    const { ttsQueueId, signal } = session.newTtsQueue()

    // Request chunk i from the provider. Only kind='blob-url' is supported in v3.0;
    // anything else fails loudly rather than being played wrong.
    const synth = (i) => provider.synthesize({
      text: chunks[i],
      voice,
      sessionId: session.id,
      ttsQueueId,
      chunkIndex: i
    }, signal).then(result => {
      if (result?.kind !== 'blob-url') {
        try { result?.revoke?.() } catch (e) { /* ignore */ }
        throw new Error(`unsupported TTS result kind: ${result?.kind}`)
      }
      session.trackRevoker(result.revoke)
      return result
    })

    // Promise for the next chunk, started while the current one plays.
    // Holding the promise (not the resolved URL) means we never request a chunk twice.
    let pending = null

    for (let i = 0; i < chunks.length; i++) {
      if (session.cancelled || signal.aborted) return

      onEvent('CHUNK_PLAYING', {
        sessionId: session.id,
        ttsQueueId,
        chunkIndex: i,
        totalChunks: chunks.length
      })
      onEvent('SPEAK_PROGRESS', {
        sessionId: session.id,
        ttsQueueId,
        chunkIndex: i,
        totalChunks: chunks.length
      })

      const current = pending || synth(i)
      pending = null

      let result
      try {
        result = await current
      } catch (err) {
        if (signal.aborted || session.cancelled) return
        onEvent('CHUNK_FAILED', {
          sessionId: session.id,
          ttsQueueId,
          chunkIndex: i,
          code: err?.status ? `tts-http-${err.status}` : 'tts-failed',
          error: err?.message || 'tts-fetch-failed'
        })
        continue
      }

      if (i + 1 < chunks.length && !signal.aborted) {
        pending = synth(i + 1)
        pending.catch(() => { /* surfaced when awaited next iteration */ })
      }

      try {
        await this._playBlob(result.url, signal)
        result.revoke()
      } catch (err) {
        if (signal.aborted || session.cancelled) return
        if (err?.code === 'autoplay-rejected') {
          // Keep the URL alive: resumePending() replays the same src.
          // session.cancel() revokes it later via trackRevoker.
          onEvent('TAP_TO_PLAY', { sessionId: session.id, ttsQueueId })
          return
        }
        result.revoke()
        onEvent('CHUNK_FAILED', {
          sessionId: session.id,
          ttsQueueId,
          chunkIndex: i,
          code: 'playback-failed',
          error: err?.message || 'playback-failed'
        })
        continue
      }
    }

    if (!session.cancelled && !signal.aborted) {
      onEvent('SPEAK_DONE', { sessionId: session.id, ttsQueueId })
    }
  }

  /**
   * Plays a single blob URL through the persistent <audio> element.
   * Returns a promise that resolves on `ended` or rejects on error/abort.
   */
  _playBlob(blobUrl, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'))
        return
      }
      const audio = this.fallbackAudio
      if (!audio) {
        reject(new Error('audio-engine-not-unlocked'))
        return
      }

      const cleanup = () => {
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        signal.removeEventListener('abort', onAbort)
      }
      const onEnded = () => { cleanup(); resolve() }
      const onError = () => {
        cleanup()
        const e = new Error(audio.error?.message || 'audio-element-error')
        reject(e)
      }
      const onAbort = () => {
        cleanup()
        try { audio.pause() } catch (e) { /* ignore */ }
        reject(new Error('aborted'))
      }

      audio.addEventListener('ended', onEnded, { once: true })
      audio.addEventListener('error', onError, { once: true })
      signal.addEventListener('abort', onAbort, { once: true })

      audio.src = blobUrl
      const playPromise = audio.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(err => {
          cleanup()
          // Distinguish autoplay rejection from other errors
          if (err.name === 'NotAllowedError') {
            const e = new Error('autoplay-rejected')
            e.code = 'autoplay-rejected'
            reject(e)
          } else {
            reject(err)
          }
        })
      }
    })
  }

  /**
   * Stop current playback and detach from session.
   * Does NOT destroy fallbackAudio — keep it persistent for Safari.
   */
  stop() {
    this._stopPlayback()
    this.currentSession = null
  }

  _stopPlayback() {
    if (this.fallbackAudio) {
      try { this.fallbackAudio.pause() } catch (e) { /* ignore */ }
      // Do NOT removeAttribute('src') or set src='' — Safari treats those as errors
      // The next play() will set src to the new blob URL, replacing the old.
    }
  }

  isPlaying() {
    return Boolean(this.fallbackAudio) && !this.fallbackAudio.paused
  }

  /**
   * Resume playback after a tap-to-play UI was shown (Safari autoplay rejection).
   * Returns true if resume succeeded.
   */
  async resumePending() {
    if (!this.fallbackAudio) return false
    try {
      await this.fallbackAudio.play()
      return true
    } catch (e) {
      return false
    }
  }
}

export const audioEngine = new AudioEngine()
export { AudioEngine }
