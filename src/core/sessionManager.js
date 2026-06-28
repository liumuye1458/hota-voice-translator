// src/core/sessionManager.js
//
// Session lifecycle for v2.0.
// Each push-to-talk press / text send creates a Session with:
//   - immutable direction (locked at construction)
//   - sessionId (used for stale-event rejection across sessions)
//   - per-phase attemptIds (used for stale-event rejection within retries)
//   - per-phase AbortControllers (for fetch cancellation)
//   - resources (mediaStream/recorder/audioPlayback/blob URLs)
//
// Core invariant: at most ONE non-cancelled session active at a time.
// Starting a new session implicitly cancels any prior active session.

let sessionCounter = 0

export class Session {
  constructor({ direction, inputMode }) {
    if (direction !== 'zh→id' && direction !== 'id→zh') {
      throw new Error(`Invalid direction: ${direction}`)
    }
    if (inputMode !== 'voice' && inputMode !== 'text') {
      throw new Error(`Invalid inputMode: ${inputMode}`)
    }
    sessionCounter += 1
    this.id = `s_${sessionCounter}_${Date.now().toString(36)}`
    this.direction = direction          // IMMUTABLE after this point
    this.inputMode = inputMode          // IMMUTABLE
    this.createdAt = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    this.abortControllers = {
      transcribe: null,
      translate: null,
      tts: null
    }
    this.attemptIds = {
      transcribe: 0,
      translate: 0,
      tts: 0
    }
    this.resources = {
      mediaStream: null,
      mediaRecorder: null,
      currentAudioPlayback: null,
      blobUrls: new Set()
    }
    this.errors = []
    this.cancelled = false
    this._cancelReason = null
  }

  // Start a new transcribe attempt. Aborts any in-flight transcribe.
  // Returns { attemptId, signal } for the caller to use in the fetch.
  newTranscribeAttempt() {
    this.attemptIds.transcribe += 1
    if (this.abortControllers.transcribe) {
      try { this.abortControllers.transcribe.abort() } catch (e) { /* ignore */ }
    }
    this.abortControllers.transcribe = new AbortController()
    return {
      attemptId: this.attemptIds.transcribe,
      signal: this.abortControllers.transcribe.signal
    }
  }

  newTranslateAttempt() {
    this.attemptIds.translate += 1
    if (this.abortControllers.translate) {
      try { this.abortControllers.translate.abort() } catch (e) { /* ignore */ }
    }
    this.abortControllers.translate = new AbortController()
    return {
      attemptId: this.attemptIds.translate,
      signal: this.abortControllers.translate.signal
    }
  }

  newTtsQueue() {
    this.attemptIds.tts += 1
    if (this.abortControllers.tts) {
      try { this.abortControllers.tts.abort() } catch (e) { /* ignore */ }
    }
    this.abortControllers.tts = new AbortController()
    return {
      ttsQueueId: this.attemptIds.tts,
      signal: this.abortControllers.tts.signal
    }
  }

  recordError({ code, msg }) {
    this.errors.push({
      ts: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      code,
      msg
    })
  }

  trackBlobUrl(url) {
    if (url) this.resources.blobUrls.add(url)
  }

  cancel(reason = 'unknown') {
    if (this.cancelled) return
    this.cancelled = true
    this._cancelReason = reason

    // 1. Abort all in-flight HTTP requests
    for (const key of Object.keys(this.abortControllers)) {
      const ctrl = this.abortControllers[key]
      if (ctrl) {
        try { ctrl.abort() } catch (e) { /* ignore */ }
        this.abortControllers[key] = null
      }
    }

    // 2. Detach handler and stop MediaRecorder BEFORE stopping tracks
    if (this.resources.mediaRecorder) {
      const mr = this.resources.mediaRecorder
      try { mr.ondataavailable = null } catch (e) { /* ignore */ }
      try { mr.onerror = null } catch (e) { /* ignore */ }
      try { mr.onstop = null } catch (e) { /* ignore */ }
      try {
        if (mr.state !== 'inactive') mr.stop()
      } catch (e) { /* ignore */ }
      this.resources.mediaRecorder = null
    }

    // 3. Stop media stream tracks
    if (this.resources.mediaStream) {
      try {
        this.resources.mediaStream.getTracks().forEach(t => t.stop())
      } catch (e) { /* ignore */ }
      this.resources.mediaStream = null
    }

    // 4. Stop audio playback handle (audioEngine-specific)
    if (this.resources.currentAudioPlayback) {
      try {
        if (typeof this.resources.currentAudioPlayback.stop === 'function') {
          this.resources.currentAudioPlayback.stop()
        }
      } catch (e) { /* ignore */ }
      this.resources.currentAudioPlayback = null
    }

    // 5. Revoke blob URLs
    for (const url of this.resources.blobUrls) {
      try { URL.revokeObjectURL(url) } catch (e) { /* ignore */ }
    }
    this.resources.blobUrls.clear()
  }
}

export class SessionManager {
  constructor() {
    this.activeSessions = new Set()
  }

  /**
   * Create a new session. If there's an active session, it's cancelled first
   * (implements the "START during active state cancels prior" rule).
   */
  create({ direction, inputMode }) {
    if (this.activeSessions.size > 0) {
      this.cancelAll('superseded')
    }
    const session = new Session({ direction, inputMode })
    this.activeSessions.add(session)
    return session
  }

  /** Cancel ALL active sessions. Used by forceReset() and create(). */
  cancelAll(reason = 'user') {
    for (const s of this.activeSessions) {
      s.cancel(reason)
    }
    this.activeSessions.clear()
  }

  /**
   * Returns true iff this exact session is current and not cancelled.
   * Used by services/audio engine to determine if their callback is still valid.
   */
  isCurrent(session) {
    return Boolean(session) && !session.cancelled && this.activeSessions.has(session)
  }

  /** Dispose a completed session (success path). */
  dispose(session) {
    if (session) {
      session.cancel('completed')
      this.activeSessions.delete(session)
    }
  }
}

// Singleton instance — the entire app uses one.
export const sessionManager = new SessionManager()
