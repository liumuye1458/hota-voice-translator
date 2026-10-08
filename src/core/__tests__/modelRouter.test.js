import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyError,
  TranslationModelRouter,
  runWithModelRouting
} from '../modelRouter.js'

const httpErr = (status, message = '', code = null) => Object.assign(new Error(message), { status, code })
const noSleep = async () => {}

// ---- classifyError: PRD-002 §5.1 matrix ----

test('classify: abort is never retried or fallen back', () => {
  const e = new Error('aborted'); e.name = 'AbortError'
  assert.equal(classifyError(e), 'aborted')
})

test('classify: fetch failure with no status → network', () => {
  assert.equal(classifyError(new TypeError('Failed to fetch')), 'network')
})

test('classify: 401 / 403 → auth (no fallback)', () => {
  assert.equal(classifyError(httpErr(401, 'Incorrect API key provided')), 'auth')
  assert.equal(classifyError(httpErr(403, 'Forbidden')), 'auth')
})

test('classify: model_not_found code → capability regardless of status', () => {
  assert.equal(classifyError(httpErr(403, 'x', 'model_not_found')), 'capability')
  assert.equal(classifyError(httpErr(404, 'x', 'model_not_found')), 'capability')
})

test('classify: 400/404 mentioning the model → capability', () => {
  assert.equal(classifyError(httpErr(404, 'The model `gpt-6-luna` does not exist')), 'capability')
  assert.equal(classifyError(httpErr(400, 'You do not have access to this model')), 'capability')
})

test('classify: 400 unrelated to model → request', () => {
  assert.equal(classifyError(httpErr(400, 'There was an error parsing the body')), 'request')
})

test('classify: unsupported parameter is a request bug, not missing access (regression 2026-10-08)', () => {
  // Real gpt-6-luna response when sent temperature: 0
  const msg = "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported."
  assert.equal(classifyError(Object.assign(httpErr(400, msg, 'unsupported_value'), { param: 'temperature' })), 'request')
  // Same message even without the param field must not count as capability
  assert.equal(classifyError(httpErr(400, msg)), 'request')
})

test('classify: real "does not exist or you do not have access" message → capability', () => {
  const msg = 'The model `gpt-6-luna` does not exist or you do not have access to it.'
  assert.equal(classifyError(httpErr(404, msg)), 'capability')
})

test('classify: 429 quota/tier → capability, plain 429 → transient', () => {
  assert.equal(classifyError(httpErr(429, 'You exceeded your current quota', 'insufficient_quota')), 'capability')
  assert.equal(classifyError(httpErr(429, 'Rate limit reached for requests')), 'transient')
})

test('classify: 5xx → transient', () => {
  assert.equal(classifyError(httpErr(500, 'server error')), 'transient')
  assert.equal(classifyError(httpErr(503, 'overloaded')), 'transient')
})

// ---- Router state ----

test('router: luna falls back to mini; mini and 4o have no fallback', () => {
  assert.equal(new TranslationModelRouter('gpt-6-luna').canFallback(), true)
  assert.equal(new TranslationModelRouter('gpt-5.4-mini').canFallback(), false)
  assert.equal(new TranslationModelRouter('gpt-4o').canFallback(), false)
})

test('router: markCapabilityFailure is sticky until reset', () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  const ev = r.markCapabilityFailure(httpErr(404, 'model does not exist'))
  assert.deepEqual([ev.from, ev.to, ev.reason, ev.status], ['gpt-6-luna', 'gpt-5.4-mini', 'capability', 404])
  assert.equal(r.currentModel(), 'gpt-5.4-mini')
  assert.equal(r.canFallback(), false)
  r.reset()
  assert.equal(r.currentModel(), 'gpt-6-luna')
})

// ---- runWithModelRouting ----

test('routing: success on preferred model', async () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  const out = await runWithModelRouting(r, async m => `ok:${m}`, { sleep: noSleep })
  assert.deepEqual(out, { result: 'ok:gpt-6-luna', model: 'gpt-6-luna', fellBack: false })
})

test('routing: capability error → fallback once, then sticky (no more luna calls)', async () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  const calls = []
  const events = []
  const call = async (m) => {
    calls.push(m)
    if (m === 'gpt-6-luna') throw httpErr(404, 'The model does not exist')
    return `ok:${m}`
  }
  const first = await runWithModelRouting(r, call, { sleep: noSleep, onFallback: e => events.push(e) })
  assert.equal(first.model, 'gpt-5.4-mini')
  assert.equal(first.fellBack, true)
  assert.equal(events.length, 1)

  const second = await runWithModelRouting(r, call, { sleep: noSleep, onFallback: e => events.push(e) })
  assert.equal(second.model, 'gpt-5.4-mini')
  assert.equal(second.fellBack, false)
  assert.equal(events.length, 1, 'fallback event fires only once per session')
  assert.deepEqual(calls, ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-5.4-mini'])
})

test('routing: transient error → one retry on same model, no downgrade', async () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  let n = 0
  const out = await runWithModelRouting(r, async m => {
    n += 1
    if (n === 1) throw httpErr(503, 'overloaded')
    return `ok:${m}`
  }, { sleep: noSleep })
  assert.equal(out.model, 'gpt-6-luna')
  assert.equal(n, 2)
  assert.equal(r.downgraded, false)
})

test('routing: transient twice → throws, still no downgrade', async () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  let n = 0
  await assert.rejects(runWithModelRouting(r, async () => { n += 1; throw httpErr(500, 'boom') }, { sleep: noSleep }))
  assert.equal(n, 2)
  assert.equal(r.downgraded, false)
})

test('routing: network error → no retry, no downgrade', async () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  let n = 0
  await assert.rejects(runWithModelRouting(r, async () => { n += 1; throw new TypeError('Failed to fetch') }, { sleep: noSleep }))
  assert.equal(n, 1)
  assert.equal(r.downgraded, false)
})

test('routing: auth error → no fallback', async () => {
  const r = new TranslationModelRouter('gpt-6-luna')
  await assert.rejects(runWithModelRouting(r, async () => { throw httpErr(401, 'Incorrect API key') }, { sleep: noSleep }))
  assert.equal(r.downgraded, false)
})

test('routing: capability error on a model with no fallback → throws', async () => {
  const r = new TranslationModelRouter('gpt-5.4-mini')
  await assert.rejects(runWithModelRouting(r, async () => { throw httpErr(404, 'model does not exist') }, { sleep: noSleep }))
})
