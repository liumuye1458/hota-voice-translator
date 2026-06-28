// src/core/translatorFSM.js
//
// Pure reducer for the v2 translation state machine.
// No side effects. No knowledge of React, OpenAI, audio, etc.
// Action creators (in hooks/useTranslator.js) handle side effects;
// the reducer only computes next state.
//
// Stale-event rejection is the single most important property here:
// any event whose (sessionId, attemptId) does not match the current
// session is silently dropped — never causes a state transition.

export const STATES = Object.freeze({
  IDLE: 'idle',
  RECORDING: 'recording',
  TRANSCRIBING: 'transcribing',
  TRANSLATING: 'translating',
  SPEAKING: 'speaking',
  ERROR: 'error'
})

export const initialState = Object.freeze({
  status: STATES.IDLE,
  session: null,           // Reference to current Session object (sessionManager owns lifecycle)
  errorBurst: [],          // Recent errors: [{code, ts}]
  speakProgress: null,     // { chunkIndex, total } during speaking
  lastError: null,         // For UI banner: { code, msg } | null
  lastEventLog: []         // Ring buffer of last 50 events for debugging
})

// Global events bypass session/attempt checks.
// START is global because it CREATES a new session (no prior session to validate against).
// Mid-session events (STOP, TRANSCRIPT_READY, etc.) must validate.
const GLOBAL_EVENTS = new Set(['RESET', 'RECOVER', 'SETTINGS_CHANGED', 'START'])

/**
 * Determine if an event should be ignored as stale.
 * Returns true → reducer must not mutate state (other than the event log).
 */
export function isStale(state, event) {
  if (GLOBAL_EVENTS.has(event.type)) return false

  // No active session → all session-specific events are stale
  if (!state.session) return true

  // Cross-session check
  if (event.sessionId !== state.session.id) return true

  // Same-session, per-phase attempt check
  switch (event.type) {
    case 'TRANSCRIPT_READY':
      return event.transcribeAttemptId !== state.session.attemptIds.transcribe
    case 'TRANSLATION_READY':
      return event.translateAttemptId !== state.session.attemptIds.translate
    case 'CHUNK_QUEUED':
    case 'CHUNK_PLAYING':
    case 'CHUNK_FAILED':
    case 'SPEAK_DONE':
    case 'SPEAK_PROGRESS':
      return event.ttsQueueId !== state.session.attemptIds.tts
    default:
      return false
  }
}

function appendLog(log, event, accepted) {
  const entry = {
    type: event.type,
    sessionId: event.sessionId || null,
    accepted,
    ts: typeof performance !== 'undefined' ? performance.now() : Date.now()
  }
  // Keep last 50
  if (log.length >= 50) return [...log.slice(-49), entry]
  return [...log, entry]
}

function appendErrorBurst(burst, code) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const recent = burst.filter(e => now - e.ts < 5000) // last 5s
  return [...recent, { code, ts: now }]
}

/**
 * Pure reducer. Given current state and an event, returns next state.
 * Does not perform any side effect; callers handle those.
 */
export function reducer(state, event) {
  // 1. Stale rejection (must happen before any transition decision)
  if (isStale(state, event)) {
    return { ...state, lastEventLog: appendLog(state.lastEventLog, event, false) }
  }

  const log = appendLog(state.lastEventLog, event, true)

  switch (event.type) {

    case 'RESET':
      return {
        ...initialState,
        lastEventLog: log
      }

    case 'RECOVER':
      // Only transitions out of error; ignored elsewhere
      if (state.status === STATES.ERROR) {
        return { ...state, status: STATES.IDLE, session: null, lastError: null, lastEventLog: log }
      }
      return { ...state, lastEventLog: log }

    case 'SETTINGS_CHANGED':
      return { ...state, lastEventLog: log }

    case 'START': {
      // Action creator must have already created the session via sessionManager.
      // The session is passed in via event.session.
      // START during any active state implicitly cancels the previous (sessionManager handles it).
      if (!event.session) {
        return { ...state, lastEventLog: log }
      }
      const nextStatus = event.inputMode === 'text' ? STATES.TRANSLATING : STATES.RECORDING
      return {
        ...state,
        status: nextStatus,
        session: event.session,
        speakProgress: null,
        lastError: null,
        lastEventLog: log
      }
    }

    case 'STOP': {
      // Only meaningful if recording
      if (state.status !== STATES.RECORDING) {
        return { ...state, lastEventLog: log }
      }
      // Action creator decides next phase based on (side, captured text):
      //  - right path with audio → 'transcribing'
      //  - left path with interim text → 'translating'
      //  - no input → 'idle'
      if (event.nextPhase === 'transcribing') {
        return { ...state, status: STATES.TRANSCRIBING, lastEventLog: log }
      }
      if (event.nextPhase === 'translating') {
        return { ...state, status: STATES.TRANSLATING, lastEventLog: log }
      }
      // No captured input — clean idle
      return { ...state, status: STATES.IDLE, session: null, lastEventLog: log }
    }

    case 'EMPTY_INPUT':
      return { ...state, status: STATES.IDLE, session: null, lastEventLog: log }

    case 'TRANSCRIPT_READY':
      if (state.status !== STATES.TRANSCRIBING) {
        return { ...state, lastEventLog: log }
      }
      return { ...state, status: STATES.TRANSLATING, lastEventLog: log }

    case 'TRANSLATION_READY':
      if (state.status !== STATES.TRANSLATING) {
        return { ...state, lastEventLog: log }
      }
      return {
        ...state,
        status: STATES.SPEAKING,
        speakProgress: { chunkIndex: 0, total: event.chunkCount || 1 },
        lastEventLog: log
      }

    case 'CHUNK_QUEUED':
    case 'CHUNK_PLAYING':
    case 'SPEAK_PROGRESS':
      return {
        ...state,
        speakProgress: {
          chunkIndex: event.chunkIndex,
          total: event.totalChunks ?? state.speakProgress?.total ?? null
        },
        lastEventLog: log
      }

    case 'CHUNK_FAILED':
      // Skip; queue continues. Record error but don't transition.
      return {
        ...state,
        errorBurst: appendErrorBurst(state.errorBurst, event.code || 'chunk-failed'),
        lastEventLog: log
      }

    case 'SPEAK_DONE':
      return {
        ...state,
        status: STATES.IDLE,
        session: null,
        speakProgress: null,
        lastEventLog: log
      }

    case 'ERROR':
    case 'TIMEOUT':
      return {
        ...state,
        status: STATES.ERROR,
        errorBurst: appendErrorBurst(state.errorBurst, event.code || event.type.toLowerCase()),
        lastError: { code: event.code || event.type.toLowerCase(), msg: event.message || '' },
        lastEventLog: log
      }

    default:
      return { ...state, lastEventLog: log }
  }
}

/**
 * Helper used by action creators to detect the "2 same-code errors in 5s"
 * auto-reset condition.
 */
export function shouldAutoReset(state) {
  const counts = new Map()
  for (const e of state.errorBurst) {
    const c = (counts.get(e.code) || 0) + 1
    counts.set(e.code, c)
    if (c >= 2) return true
  }
  return false
}
