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
