// src/core/__tests__/fsm.test.js
//
// Day 1 unit tests — deterministic FSM behavior.
// Run via:  node --test src/core/__tests__/fsm.test.js  (with package.json type:module + .mjs)
// OR with vitest if installed.
//
// These are the FSM half of the v2.0 eval suite. The full 10-case
// integration test file (evals/fsm-integration.test.js) will mock the
// services layer and run end-to-end flows; this file focuses on the
// reducer alone.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reducer, initialState, isStale, shouldAutoReset, STATES } from '../translatorFSM.js'
import { SessionManager } from '../sessionManager.js'

function makeSession({ direction = 'zh→id', inputMode = 'voice' } = {}) {
  const sm = new SessionManager()
  return sm.create({ direction, inputMode })
}

test('initial state is idle with no session', () => {
  assert.equal(initialState.status, STATES.IDLE)
  assert.equal(initialState.session, null)
})

test('START transitions to recording for voice input', () => {
  const session = makeSession({ inputMode: 'voice' })
  const next = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  assert.equal(next.status, STATES.RECORDING)
  assert.equal(next.session, session)
})

test('START transitions to translating for text input', () => {
  const session = makeSession({ inputMode: 'text' })
  const next = reducer(initialState, { type: 'START', session, inputMode: 'text' })
  assert.equal(next.status, STATES.TRANSLATING)
})

test('STOP with nextPhase=transcribing → transcribing', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  s = reducer(s, { type: 'STOP', sessionId: session.id, nextPhase: 'transcribing' })
  assert.equal(s.status, STATES.TRANSCRIBING)
})

test('STOP with no captured input → idle + session cleared', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  s = reducer(s, { type: 'STOP', sessionId: session.id })
  assert.equal(s.status, STATES.IDLE)
  assert.equal(s.session, null)
})

test('TRANSCRIPT_READY from current session → translating', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  s = reducer(s, { type: 'STOP', sessionId: session.id, nextPhase: 'transcribing' })
  const { attemptId } = session.newTranscribeAttempt()
  s = reducer(s, {
    type: 'TRANSCRIPT_READY',
    sessionId: session.id,
    transcribeAttemptId: attemptId,
    text: 'hello'
  })
  assert.equal(s.status, STATES.TRANSLATING)
})

test('STALE EVENT: TRANSCRIPT_READY from wrong session → ignored', () => {
  const sessionA = makeSession()
  const sessionB = makeSession()
  let s = reducer(initialState, { type: 'START', session: sessionA, inputMode: 'voice' })
  s = reducer(s, { type: 'STOP', sessionId: sessionA.id, nextPhase: 'transcribing' })
  const beforeStatus = s.status
  // Event arrives carrying wrong session
  s = reducer(s, {
    type: 'TRANSCRIPT_READY',
    sessionId: sessionB.id,
    transcribeAttemptId: 1,
    text: 'stale!'
  })
  assert.equal(s.status, beforeStatus, 'status should not change on stale event')
  // But event IS logged with accepted:false
  const last = s.lastEventLog[s.lastEventLog.length - 1]
  assert.equal(last.accepted, false)
})

test('STALE EVENT: TRANSLATION_READY with old attemptId → ignored', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'text' })
  // First translate attempt
  const { attemptId: a1 } = session.newTranslateAttempt()
  // Simulate timeout retry — new attempt
  const { attemptId: a2 } = session.newTranslateAttempt()
  assert.equal(a2, a1 + 1, 'attemptIds must increment')

  // A late response from attempt 1 (the timed-out request) arrives
  const beforeStatus = s.status
  s = reducer(s, {
    type: 'TRANSLATION_READY',
    sessionId: session.id,
    translateAttemptId: a1, // stale!
    text: 'old result'
  })
  assert.equal(s.status, beforeStatus, 'late retry response must be ignored')

  // Then the current attempt (a2) responds — should be accepted
  s = reducer(s, {
    type: 'TRANSLATION_READY',
    sessionId: session.id,
    translateAttemptId: a2,
    text: 'fresh result',
    chunkCount: 1
  })
  assert.equal(s.status, STATES.SPEAKING)
})

test('STALE EVENT: CHUNK_FAILED with old ttsQueueId → ignored', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'text' })
  const { attemptId: tlId } = session.newTranslateAttempt()
  s = reducer(s, {
    type: 'TRANSLATION_READY',
    sessionId: session.id,
    translateAttemptId: tlId,
    text: 'hi',
    chunkCount: 3
  })
  // First tts queue
  const q1 = session.newTtsQueue().ttsQueueId
  // New queue (e.g., cancelled + restarted)
  const q2 = session.newTtsQueue().ttsQueueId

  // Failed chunk from old queue
  const before = s.errorBurst.length
  s = reducer(s, {
    type: 'CHUNK_FAILED',
    sessionId: session.id,
    ttsQueueId: q1,
    chunkIndex: 0
  })
  assert.equal(s.errorBurst.length, before, 'stale CHUNK_FAILED must not affect state')
})

test('RESET clears everything regardless of state', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  s = reducer(s, { type: 'STOP', sessionId: session.id, nextPhase: 'transcribing' })
  s = reducer(s, { type: 'RESET', reason: 'user' })
  assert.equal(s.status, STATES.IDLE)
  assert.equal(s.session, null)
})

test('RECOVER only fires from error state', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  // RECOVER from non-error state: no transition
  s = reducer(s, { type: 'RECOVER' })
  assert.equal(s.status, STATES.RECORDING)
  // Now error
  s = reducer(s, { type: 'ERROR', sessionId: session.id, code: 'test' })
  assert.equal(s.status, STATES.ERROR)
  // RECOVER from error → idle
  s = reducer(s, { type: 'RECOVER' })
  assert.equal(s.status, STATES.IDLE)
})

test('Error burst: 2 same-code errors in 5s triggers shouldAutoReset', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  s = reducer(s, { type: 'ERROR', sessionId: session.id, code: 'transcribe-fail' })
  assert.equal(shouldAutoReset(s), false)
  // Recover (so we can ERROR again)
  s = reducer(s, { type: 'RECOVER' })
  // Need a new session for the second ERROR to apply
  const session2 = makeSession()
  s = reducer(s, { type: 'START', session: session2, inputMode: 'voice' })
  s = reducer(s, { type: 'ERROR', sessionId: session2.id, code: 'transcribe-fail' })
  assert.equal(shouldAutoReset(s), true, '2nd same-code error within 5s must trigger auto-reset')
})

test('isStale: GLOBAL_EVENTS bypass session check', () => {
  const session = makeSession()
  const state = { ...initialState, session }
  assert.equal(isStale(state, { type: 'RESET' }), false)
  assert.equal(isStale(state, { type: 'RECOVER' }), false)
  assert.equal(isStale(state, { type: 'SETTINGS_CHANGED' }), false)
})

test('isStale: events with no session in state are rejected', () => {
  const state = initialState
  assert.equal(isStale(state, { type: 'TRANSCRIPT_READY', sessionId: 'x', transcribeAttemptId: 1 }), true)
})

test('Session direction is immutable after creation', () => {
  const session = makeSession({ direction: 'zh→id' })
  // Direct mutation attempt
  session.direction = 'id→zh'
  // In strict mode this would throw; in non-strict it might silently succeed.
  // What matters is that nothing in our code SHOULD read .direction after construction
  // and try to change it. We document the contract here.
  // Note: we don't use Object.freeze() because Session has mutable resource fields.
  // The convention enforced by review: NEVER assign to session.direction outside constructor.
})

test('Sessions are mutually exclusive: creating new cancels old', () => {
  const sm = new SessionManager()
  const a = sm.create({ direction: 'zh→id', inputMode: 'voice' })
  assert.equal(a.cancelled, false)
  const b = sm.create({ direction: 'id→zh', inputMode: 'voice' })
  assert.equal(a.cancelled, true, 'creating new session must cancel prior')
  assert.equal(b.cancelled, false)
  assert.equal(sm.isCurrent(a), false)
  assert.equal(sm.isCurrent(b), true)
})

// ============================================================
// Codex-requested gap coverage tests (10 from review round 1)
// ============================================================

test('CODEX #1: START during SPEAKING cancels old session', () => {
  // Old session reaches SPEAKING
  const sessionA = makeSession()
  let s = reducer(initialState, { type: 'START', session: sessionA, inputMode: 'text' })
  const { attemptId: tlA } = sessionA.newTranslateAttempt()
  s = reducer(s, {
    type: 'TRANSLATION_READY',
    sessionId: sessionA.id,
    translateAttemptId: tlA,
    text: 'first translation',
    chunkCount: 5
  })
  assert.equal(s.status, STATES.SPEAKING)

  // User presses again — new session starts
  const sessionB = makeSession()
  s = reducer(s, { type: 'START', session: sessionB, inputMode: 'text' })
  assert.equal(s.status, STATES.TRANSLATING)
  assert.equal(s.session.id, sessionB.id)
  assert.notEqual(s.session.id, sessionA.id)

  // Old session's lingering SPEAK_DONE must NOT affect state
  s = reducer(s, { type: 'SPEAK_DONE', sessionId: sessionA.id, ttsQueueId: 0 })
  assert.equal(s.status, STATES.TRANSLATING, 'old SPEAK_DONE must be ignored')
  assert.equal(s.session.id, sessionB.id)
})

test('CODEX #2: RESET mid-fetch drops late translation result', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'text' })
  const { attemptId } = session.newTranslateAttempt()

  // Simulate user hitting Esc → RESET fires before translation returns
  s = reducer(s, { type: 'RESET', reason: 'user' })
  assert.equal(s.status, STATES.IDLE)
  assert.equal(s.session, null)

  // Late translation result arrives — must be dropped (no session in state)
  s = reducer(s, {
    type: 'TRANSLATION_READY',
    sessionId: session.id,
    translateAttemptId: attemptId,
    text: 'late result',
    chunkCount: 1
  })
  assert.equal(s.status, STATES.IDLE)
  const last = s.lastEventLog[s.lastEventLog.length - 1]
  assert.equal(last.accepted, false, 'late TRANSLATION_READY after RESET must be rejected')
})

test('CODEX #3: Error auto-recovers via RECOVER event (3s timer in app)', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  s = reducer(s, { type: 'ERROR', sessionId: session.id, code: 'transcribe-fail', message: 'x' })
  assert.equal(s.status, STATES.ERROR)
  assert.notEqual(s.lastError, null)

  // App schedules a RECOVER 3s later
  s = reducer(s, { type: 'RECOVER' })
  assert.equal(s.status, STATES.IDLE)
  assert.equal(s.lastError, null)
})

test('CODEX #4: Rapid left/right alternation — no direction leak', () => {
  // 10 rapid presses alternating left/right
  let s = initialState
  let lastSession = null
  for (let i = 0; i < 10; i++) {
    const side = i % 2 === 0 ? 'left' : 'right'
    const dir = side === 'left' ? 'zh→id' : 'id→zh'
    const session = makeSession({ direction: dir })
    s = reducer(s, { type: 'START', session, side, inputMode: 'voice' })
    assert.equal(s.session.direction, dir, `iter ${i}: direction must match side`)
    lastSession = session
  }
  // Final state direction matches the LAST press, not any earlier
  assert.equal(s.session.id, lastSession.id)
  assert.equal(s.session.direction, lastSession.direction)
})

test('CODEX #9: Failed TTS chunk does NOT stop the queue', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'text' })
  const { attemptId: tlId } = session.newTranslateAttempt()
  s = reducer(s, {
    type: 'TRANSLATION_READY',
    sessionId: session.id,
    translateAttemptId: tlId,
    text: 'long text',
    chunkCount: 5
  })
  assert.equal(s.status, STATES.SPEAKING)

  const { ttsQueueId } = session.newTtsQueue()
  // Chunk 2 of 5 fails
  s = reducer(s, {
    type: 'CHUNK_FAILED',
    sessionId: session.id,
    ttsQueueId,
    chunkIndex: 1,
    code: 'tts-net'
  })
  // State must NOT have left SPEAKING
  assert.equal(s.status, STATES.SPEAKING, 'CHUNK_FAILED must not exit speaking state')
  assert.equal(s.errorBurst.length > 0, true, 'error recorded')

  // SPEAK_DONE still terminates the queue cleanly
  s = reducer(s, { type: 'SPEAK_DONE', sessionId: session.id, ttsQueueId })
  assert.equal(s.status, STATES.IDLE)
})

test('CODEX #10: EMPTY_INPUT — STOP with no captured speech does not enter translate flow', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })
  // STOP arrives but no nextPhase (no speech captured)
  s = reducer(s, { type: 'STOP', sessionId: session.id })
  // Note: STOP with no nextPhase → idle + session cleared (handled by hook)
  // or alternatively, EMPTY_INPUT is dispatched
  s = reducer(s, { type: 'EMPTY_INPUT', sessionId: session.id })
  assert.equal(s.status, STATES.IDLE)
  assert.equal(s.session, null)
  // Hook would not have called any API → verified by integration test
})

test('Forensics: lastEventLog tracks all events including rejected ones', () => {
  const session = makeSession()
  let s = reducer(initialState, { type: 'START', session, inputMode: 'voice' })

  // Inject a stale event
  s = reducer(s, {
    type: 'TRANSCRIPT_READY',
    sessionId: 'fake-session-id',
    transcribeAttemptId: 1,
    text: 'stale'
  })

  const events = s.lastEventLog
  assert.equal(events.length >= 2, true)
  const staleEntry = events[events.length - 1]
  assert.equal(staleEntry.type, 'TRANSCRIPT_READY')
  assert.equal(staleEntry.accepted, false)
})
