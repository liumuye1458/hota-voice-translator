// ADR-005 — realtime STT lifecycle and fallback reasons, with a fake socket.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RealtimeTranscriber, SecretCache, transcriptionSessionConfig } from '../realtimeStt.js'
import { Resampler, floatToPcm16, bytesToBase64 } from '../pcm.js'

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms))

// Fake WebSocket: records sent events; test drives open/messages.
function makeWS({ autoOpen = true, onSend } = {}) {
  const sockets = []
  class FakeWS {
    constructor(url, protocols) {
      this.url = url
      this.protocols = protocols
      this.sent = []
      this.closed = false
      sockets.push(this)
      if (autoOpen) setTimeout(() => this.onopen?.(), 0)
    }
    send(data) { const e = JSON.parse(data); this.sent.push(e); onSend?.(this, e) }
    close() { this.closed = true }
    emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }) }
  }
  return { FakeWS, sockets }
}

// Fake capture: exposes push(nSamples) to feed 48 kHz frames.
function makeCapture() {
  const cap = { onFrame: null, stopped: false }
  cap.create = async (stream, onFrame) => {
    cap.onFrame = onFrame
    return { stop: () => { cap.stopped = true } }
  }
  cap.push = (n) => cap.onFrame(new Float32Array(n).fill(0.1), 48000)
  return cap
}

const completedOn = (text) => (ws, e) => {
  if (e.type === 'input_audio_buffer.commit') {
    setTimeout(() => ws.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: text }), 1)
  }
}

test('happy path: audio before open is queued, flushed, committed → transcript', async () => {
  const { FakeWS, sockets } = makeWS({ autoOpen: false, onSend: completedOn('明天十点开播') })
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek_1', createCapture: cap.create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(1)
  cap.push(9600)            // 200 ms @48k → 100 ms @24k → one batch, queued
  assert.equal(sockets[0].sent.length, 0)
  sockets[0].onopen()
  assert.equal(sockets[0].sent[0].type, 'input_audio_buffer.append')
  cap.push(9600)            // sent directly
  const r = await t.finish()
  assert.deepEqual(r, { ok: true, text: '明天十点开播' })
  assert.deepEqual(sockets[0].protocols, ['realtime', 'openai-insecure-api-key.ek_1'])
  const types = sockets[0].sent.map(e => e.type)
  assert.deepEqual(types, ['input_audio_buffer.append', 'input_audio_buffer.append', 'input_audio_buffer.commit'])
  assert.ok(cap.stopped)
  assert.ok(sockets[0].closed)
})

test('not connected at release → not-connected-at-release', async () => {
  const { FakeWS } = makeWS({ autoOpen: false })
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek', createCapture: cap.create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(1)
  cap.push(9600)
  assert.deepEqual(await t.finish(), { ok: false, reason: 'not-connected-at-release' })
})

test('secret mint failure → failed with reason', async () => {
  const { FakeWS } = makeWS()
  const cap = makeCapture()
  const t = new RealtimeTranscriber({
    getSecret: async () => { throw Object.assign(new Error('Incorrect API key'), { status: 401 }) },
    createCapture: cap.create, WebSocketImpl: FakeWS
  })
  t.start({})
  await tick(1)
  cap.push(9600)
  const r = await t.finish()
  assert.equal(r.ok, false)
  assert.match(r.reason, /^secret: 401/)
})

test('less than 100 ms captured → no-audio-captured (caller decides via recording)', async () => {
  const { FakeWS } = makeWS()
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek', createCapture: cap.create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(5)
  cap.push(2400)            // 50 ms
  assert.deepEqual(await t.finish(), { ok: false, reason: 'no-audio-captured' })
})

test('server error after commit → failed reason, no throw', async () => {
  const { FakeWS } = makeWS({
    onSend: (ws, e) => { if (e.type === 'input_audio_buffer.commit') setTimeout(() => ws.emit({ type: 'error', error: { message: 'boom' } }), 1) }
  })
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek', createCapture: cap.create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(5)
  cap.push(9600)
  assert.deepEqual(await t.finish(), { ok: false, reason: 'server-error: boom' })
})

test('no completion within timeout → commit-timeout', async () => {
  const { FakeWS } = makeWS()
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek', createCapture: cap.create, WebSocketImpl: FakeWS, commitTimeoutMs: 20 })
  t.start({})
  await tick(5)
  cap.push(9600)
  assert.deepEqual(await t.finish(), { ok: false, reason: 'commit-timeout' })
})

test('empty transcript → empty-transcript (caller retries via upload)', async () => {
  const { FakeWS } = makeWS({ onSend: completedOn('  ') })
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek', createCapture: cap.create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(5)
  cap.push(9600)
  assert.deepEqual(await t.finish(), { ok: false, reason: 'empty-transcript' })
})

test('socket closing mid-recording → failed', async () => {
  const { FakeWS, sockets } = makeWS()
  const cap = makeCapture()
  const t = new RealtimeTranscriber({ getSecret: async () => 'ek', createCapture: cap.create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(5)
  cap.push(9600)
  sockets[0].onclose({ code: 1006 })
  assert.deepEqual(await t.finish(), { ok: false, reason: 'socket-closed-1006' })
})

test('capture failure (e.g. no AudioWorklet) → failed', async () => {
  const { FakeWS } = makeWS()
  const t = new RealtimeTranscriber({
    getSecret: async () => 'ek',
    createCapture: async () => { throw new Error('AudioWorklet unsupported') },
    WebSocketImpl: FakeWS
  })
  t.start({})
  const r = await t.finish()
  assert.equal(r.ok, false)
  assert.match(r.reason, /capture: AudioWorklet unsupported/)
})

// Codex review v4 #1: capture setup that never settles must not block release
test('capture setup never settles → capture-not-ready within the bound', async () => {
  const { FakeWS } = makeWS()
  const t = new RealtimeTranscriber({
    getSecret: async () => 'ek',
    createCapture: () => new Promise(() => {}),   // e.g. AudioContext.resume() pending forever
    WebSocketImpl: FakeWS,
    captureReadyTimeoutMs: 30
  })
  t.start({})
  const t0 = Date.now()
  assert.deepEqual(await t.finish(), { ok: false, reason: 'capture-not-ready' })
  assert.ok(Date.now() - t0 < 500)
})

// Codex review v4 #6: opening words only in the MediaRecorder clip → use upload
test('capture ready too late after start → capture-started-late', async () => {
  const { FakeWS } = makeWS({ onSend: completedOn('后半句') })
  const cap = makeCapture()
  const t = new RealtimeTranscriber({
    getSecret: async () => 'ek',
    createCapture: async (s, f) => { await tick(60); return cap.create(s, f) },
    WebSocketImpl: FakeWS,
    lateStartMs: 20
  })
  t.start({})
  await tick(80)
  cap.push(9600)
  assert.deepEqual(await t.finish(), { ok: false, reason: 'capture-started-late' })
})

test('close() before connect: socket opened later is not used; idempotent', async () => {
  let release
  const { FakeWS, sockets } = makeWS()
  const t = new RealtimeTranscriber({ getSecret: () => new Promise(r => { release = r }), createCapture: makeCapture().create, WebSocketImpl: FakeWS })
  t.start({})
  await tick(1)            // getSecret is called asynchronously
  t.close()
  t.close()
  release('ek')
  await tick(5)
  assert.equal(sockets.length, 0)
})

test('session config shape', () => {
  const c = transcriptionSessionConfig({ model: 'gpt-live-transcribe', language: 'zh', prompt: '印尼盾' })
  assert.deepEqual(c, {
    type: 'transcription',
    audio: { input: { format: { type: 'audio/pcm', rate: 24000 }, transcription: { model: 'gpt-live-transcribe', language: 'zh', prompt: '印尼盾' }, turn_detection: null } }
  })
})

// ---- SecretCache -------------------------------------------------------

test('SecretCache reuses, dedupes in-flight, refreshes near expiry, drops failures', async () => {
  let now = 1_000_000
  let mints = 0
  const cache = new SecretCache(async () => { mints++; return { value: 'ek_' + mints, expiresAt: now + 600_000 } }, { now: () => now })
  const cfg = { a: 1 }
  const [a, b] = await Promise.all([cache.get('k', cfg), cache.get('k', cfg)])
  assert.equal(a, 'ek_1'); assert.equal(b, 'ek_1'); assert.equal(mints, 1)
  now += 500_000                       // 100 s left > 60 s margin
  assert.equal(await cache.get('k', cfg), 'ek_1')
  now += 50_000                        // 50 s left < margin → re-mint
  assert.equal(await cache.get('k', cfg), 'ek_2')
  assert.equal(await cache.get('k', { a: 2 }), 'ek_3')   // different config
  const failing = new SecretCache(async () => { throw new Error('x') })
  await assert.rejects(failing.get('k', cfg))
  await assert.rejects(failing.get('k', cfg))             // not cached
})

// ---- PCM -----------------------------------------------------------------

test('Resampler 48k→24k halves length across frame boundaries without drift', () => {
  const r = new Resampler(48000, 24000)
  let total = 0
  for (let i = 0; i < 100; i++) total += r.process(new Float32Array(128).fill(0.5)).length
  assert.ok(Math.abs(total - 6400) <= 1, `got ${total}`)
})

test('Resampler 44.1k→24k keeps the rate ratio', () => {
  const r = new Resampler(44100, 24000)
  let total = 0
  for (let i = 0; i < 1000; i++) total += r.process(new Float32Array(128)).length
  assert.ok(Math.abs(total - Math.round(128000 * 24000 / 44100)) <= 1, `got ${total}`)
})

test('PCM16 little-endian encoding with clipping + base64', () => {
  const bytes = floatToPcm16(Float32Array.from([0, 1, -1, 2]))
  assert.deepEqual([...bytes], [0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x7f])
  assert.equal(bytesToBase64(Uint8Array.from([104, 105])), 'aGk=')
})
