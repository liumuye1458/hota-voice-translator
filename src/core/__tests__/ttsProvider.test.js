import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIStandardTTS, TTSError } from '../ttsProvider.js'

const req = { text: 'Halo', voice: 'nova', sessionId: 's1', ttsQueueId: 1, chunkIndex: 0 }

function okFetch(captured) {
  return async (url, init) => {
    captured.push({ url, init })
    return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), { status: 200 })
  }
}

test('success returns a blob-url result', async () => {
  const p = new OpenAIStandardTTS({ apiKey: 'k', fetchImpl: okFetch([]) })
  const r = await p.synthesize(req)
  assert.equal(r.kind, 'blob-url')
  assert.match(r.url, /^blob:/)
  assert.equal(typeof r.revoke, 'function')
  r.revoke()
})

test('request carries model, voice, mp3 format, auth and JSON content type', async () => {
  const captured = []
  const p = new OpenAIStandardTTS({ apiKey: 'sk-test', model: 'gpt-4o-mini-tts', fetchImpl: okFetch(captured) })
  ;(await p.synthesize({ ...req, voice: 'onyx' })).revoke()
  const { url, init } = captured[0]
  assert.equal(url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(init.headers['Content-Type'], 'application/json')
  assert.equal(init.headers.Authorization, 'Bearer sk-test')
  const body = JSON.parse(init.body)
  assert.deepEqual(body, { model: 'gpt-4o-mini-tts', input: 'Halo', voice: 'onyx', response_format: 'mp3' })
})

test('revoke is idempotent and actually revokes the URL', async () => {
  const p = new OpenAIStandardTTS({ apiKey: 'k', fetchImpl: okFetch([]) })
  const r = await p.synthesize(req)
  r.revoke()
  r.revoke() // must not throw
  // After revoke, fetching the blob URL must fail
  await assert.rejects(fetch(r.url))
})

test('HTTP error → TTSError with status, body, provider, model', async () => {
  const p = new OpenAIStandardTTS({
    apiKey: 'k',
    model: 'gpt-4o-mini-tts',
    fetchImpl: async () => new Response('{"error":{"message":"Rate limit"}}', { status: 429 })
  })
  await assert.rejects(p.synthesize(req), (err) => {
    assert.ok(err instanceof TTSError)
    assert.equal(err.status, 429)
    assert.equal(err.provider, 'openai-standard')
    assert.equal(err.model, 'gpt-4o-mini-tts')
    assert.match(err.body, /Rate limit/)
    return true
  })
})

test('network failure → TTSError with null status', async () => {
  const p = new OpenAIStandardTTS({ apiKey: 'k', fetchImpl: async () => { throw new TypeError('Failed to fetch') } })
  await assert.rejects(p.synthesize(req), (err) => {
    assert.ok(err instanceof TTSError)
    assert.equal(err.status, null)
    return true
  })
})

test('abort propagates as AbortError (not wrapped)', async () => {
  const p = new OpenAIStandardTTS({
    apiKey: 'k',
    fetchImpl: async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e }
  })
  await assert.rejects(p.synthesize(req), (err) => err.name === 'AbortError')
})

test('error body is truncated to 500 chars', async () => {
  const p = new OpenAIStandardTTS({ apiKey: 'k', fetchImpl: async () => new Response('x'.repeat(2000), { status: 500 }) })
  await assert.rejects(p.synthesize(req), (err) => err.body.length === 500)
})
