// PRD-003 §3.1 — streaming translation pieces: first-sentence splitter,
// ChunkFeed, audioEngine playing a growing feed, translateTextStream.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFirstSentenceSplitter } from '../streamChunker.js'
import { ChunkFeed } from '../chunkFeed.js'
import { AudioEngine } from '../audioEngine.js'
import { SessionManager } from '../sessionManager.js'
import { translateText, translateTextStream, _resetServiceTierForTests } from '../../services/openai.js'

// ---- splitter ------------------------------------------------------------

test('splitter: Chinese sentence end followed by more text', () => {
  const s = createFirstSentenceSplitter()
  assert.equal(s.push('老板，我这个月工资少了75万印尼盾'), null)
  assert.equal(s.push('老板，我这个月工资少了75万印尼盾。'), null) // nothing after yet
  assert.equal(s.push('老板，我这个月工资少了75万印尼盾。我从'), '老板，我这个月工资少了75万印尼盾。')
  assert.equal(s.push('老板，我这个月工资少了75万印尼盾。我从来没迟到过。'), null) // only once
})

test('splitter: never splits inside numbers like Rp1.500.000 or 12.5', () => {
  const s = createFirstSentenceSplitter()
  assert.equal(s.push('Gaji kamu Rp1.'), null)
  assert.equal(s.push('Gaji kamu Rp1.500.000 dan return rate 12.5'), null)
  assert.equal(s.push('Gaji kamu Rp1.500.000 dan return rate 12.5%. Besok'), 'Gaji kamu Rp1.500.000 dan return rate 12.5%.')
})

test('splitter: too-short head is not split off', () => {
  const s = createFirstSentenceSplitter()
  // "Pak." is under MIN_CHARS, and the next boundary has nothing after it yet
  assert.equal(s.push('Pak. Saya minta izin besok.'), null)
  assert.equal(s.push('Pak. Saya minta izin besok. Anak'), 'Pak. Saya minta izin besok.')
})

// ---- ChunkFeed -------------------------------------------------------------

test('ChunkFeed: get waits for push, null after end', async () => {
  const f = new ChunkFeed()
  const p0 = f.get(0)
  const p1 = f.get(1)
  f.push('satu')
  assert.equal(await p0, 'satu')
  assert.equal(f.total, null)
  f.end()
  assert.equal(await p1, null)
  assert.equal(f.total, 1)
  f.push('late') // ignored after end
  assert.equal(f.total, 1)
})

test('ChunkFeed: abort resolves waiting get with null', async () => {
  const f = new ChunkFeed()
  const ctrl = new AbortController()
  const p = f.get(0, ctrl.signal)
  ctrl.abort()
  assert.equal(await p, null)
})

// ---- audioEngine with a growing feed ------------------------------------

function engineWithFakePlayback(played) {
  const e = new AudioEngine()
  e.unlocked = true
  e.fallbackAudio = { pause() {}, paused: true }
  e._playBlob = async (url) => { played.push(url) }
  return e
}
function fakeProvider(calls) {
  return {
    name: 'fake',
    async synthesize(req) {
      calls.push(req.text)
      return { kind: 'blob-url', url: 'blob:' + req.text, revoke() {} }
    }
  }
}

test('audioEngine plays chunks pushed after play() started, then SPEAK_DONE', async () => {
  const played = []
  const calls = []
  const events = []
  const engine = engineWithFakePlayback(played)
  const session = new SessionManager().create({ direction: 'zh→id', inputMode: 'text' })
  const feed = new ChunkFeed()
  feed.push('Kalimat pertama.')
  const done = engine.play(session, feed, 'nova', fakeProvider(calls), (t, p) => events.push([t, p]))
  await new Promise(r => setTimeout(r, 5))
  feed.push('Sisa terjemahan.')
  feed.end()
  await done
  assert.deepEqual(played, ['blob:Kalimat pertama.', 'blob:Sisa terjemahan.'])
  assert.deepEqual(calls, ['Kalimat pertama.', 'Sisa terjemahan.'])
  assert.equal(events.at(-1)[0], 'SPEAK_DONE')
  const playing = events.filter(e => e[0] === 'CHUNK_PLAYING')
  assert.equal(playing.length, 2)
  assert.equal(playing[0][1].totalChunks, null)  // unknown while streaming
  assert.equal(playing[1][1].totalChunks, 2)
})

test('audioEngine still accepts a plain array (replay path)', async () => {
  const played = []
  const engine = engineWithFakePlayback(played)
  const session = new SessionManager().create({ direction: 'zh→id', inputMode: 'text' })
  await engine.play(session, ['a', 'b'], 'nova', fakeProvider([]), () => {})
  assert.deepEqual(played, ['blob:a', 'blob:b'])
})

test('audioEngine stops waiting on an open feed when the session is cancelled', async () => {
  const engine = engineWithFakePlayback([])
  const session = new SessionManager().create({ direction: 'zh→id', inputMode: 'text' })
  const feed = new ChunkFeed() // never pushed, never ended
  const done = engine.play(session, feed, 'nova', fakeProvider([]), () => {})
  setTimeout(() => session.cancel('test'), 5)
  await done // must resolve
})

// ---- translate request shape + streaming ----------------------------------

function withFetch(impl, fn) {
  const orig = globalThis.fetch
  globalThis.fetch = impl
  return fn().finally(() => { globalThis.fetch = orig })
}
function sse(deltas) {
  const enc = new TextEncoder()
  const lines = deltas.map(d => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).concat('data: [DONE]\n\n')
  return new Response(new ReadableStream({
    start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}
const ZH = 'Chinese (Simplified, 简体中文)'
const ID = 'Indonesian (Bahasa Indonesia)'

test('Luna requests carry reasoning_effort none + temperature 0 and the domain prompt', async () => {
  const bodies = []
  await withFetch(async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Besok jam sepuluh mulai live.' } }] }), { status: 200 })
  }, () => translateText('明天十点开播', ZH, ID, 'k', '', undefined, 'gpt-6-luna'))
  const b = bodies[0]
  assert.equal(b.model, 'gpt-6-luna')
  assert.equal(b.reasoning_effort, 'none')
  assert.equal(b.temperature, 0)
  assert.equal(b.service_tier, 'priority')
  assert.match(b.messages[0].content, /憋单 = menahan order/)
  assert.match(b.messages[0].content, /8500万 = 85 juta/)
})

test('Luna asks for the priority tier; if the account rejects it, retry without and remember', async () => {
  _resetServiceTierForTests()
  const bodies = []
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: 'Besok jam sepuluh mulai live.' } }] }), { status: 200 })
  await withFetch(async (url, init) => {
    const b = JSON.parse(init.body)
    bodies.push(b)
    if (b.service_tier) {
      return new Response(JSON.stringify({ error: { message: "Invalid value for 'service_tier'", param: 'service_tier', code: 'invalid_value' } }), { status: 400 })
    }
    return ok()
  }, async () => {
    assert.equal(await translateText('明天十点开播', ZH, ID, 'k', '', undefined, 'gpt-6-luna'), 'Besok jam sepuluh mulai live.')
    await translateText('明天十点开播', ZH, ID, 'k', '', undefined, 'gpt-6-luna')
  })
  assert.deepEqual(bodies.map(b => b.service_tier ?? null), ['priority', null, null])
  _resetServiceTierForTests()
})

test('other 400s are not retried by the tier fallback', async () => {
  _resetServiceTierForTests()
  let n = 0
  await assert.rejects(withFetch(async () => {
    n++
    return new Response(JSON.stringify({ error: { message: 'bad', param: 'messages' } }), { status: 400 })
  }, () => translateText('明天', ZH, ID, 'k', '', undefined, 'gpt-6-luna')), (err) => err.status === 400 && err.param === 'messages')
  assert.equal(n, 1)
})

test('gpt-4o gets temperature only; non-Indonesian pair gets no domain prompt', async () => {
  const bodies = []
  await withFetch(async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Tomorrow at ten.' } }] }), { status: 200 })
  }, () => translateText('明天十点', ZH, 'English', 'k', '', undefined, 'gpt-4o'))
  assert.equal(bodies[0].temperature, 0)
  assert.equal(bodies[0].reasoning_effort, undefined)
  assert.doesNotMatch(bodies[0].messages[0].content, /憋单/)
})

test('user custom rules come after the domain prompt', async () => {
  const bodies = []
  await withFetch(async (url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Besok.' } }] }), { status: 200 })
  }, () => translateText('明天', ZH, ID, 'k', 'Pakai bahasa santai', undefined, 'gpt-6-luna'))
  const p = bodies[0].messages[0].content
  assert.ok(p.indexOf('Glossary') < p.indexOf('Pakai bahasa santai'))
})

test('translateTextStream emits first sentence early, then the remainder', async () => {
  const chunks = []
  let body
  const full = await withFetch(async (url, init) => {
    body = JSON.parse(init.body)
    return sse(['Besok jam sepuluh ', 'pagi mulai live. ', 'Jangan ', 'telat ya.'])
  }, () => translateTextStream('明天早上十点开播，别迟到。', ZH, ID, 'k', '', undefined, 'gpt-6-luna', (c) => chunks.push(c)))
  assert.equal(body.stream, true)
  assert.deepEqual(chunks, ['Besok jam sepuluh pagi mulai live.', 'Jangan telat ya.'])
  assert.equal(full, 'Besok jam sepuluh pagi mulai live. Jangan telat ya.')
})

test('translateTextStream: single-sentence output is emitted once at the end', async () => {
  const chunks = []
  await withFetch(async () => sse(['老板，', '我明天请假。']),
    () => translateTextStream('Pak, saya izin besok.', ID, ZH, 'k', '', undefined, 'gpt-6-luna', (c) => chunks.push(c)))
  assert.deepEqual(chunks, ['老板，我明天请假。'])
})

test('translateTextStream: wrong-language first sentence → emphatic retry, nothing wrong spoken', async () => {
  const chunks = []
  let n = 0
  const full = await withFetch(async (url, init) => {
    n++
    if (JSON.parse(init.body).stream) return sse(['明天早上十点开播，大家准备。', ' 别迟到'])
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Besok jam sepuluh mulai live.' } }] }), { status: 200 })
  }, () => translateTextStream('明天十点开播，别迟到', ZH, ID, 'k', '', undefined, 'gpt-6-luna', (c) => chunks.push(c)))
  assert.equal(n, 2)
  assert.deepEqual(chunks, ['Besok jam sepuluh mulai live.'])
  assert.equal(full, 'Besok jam sepuluh mulai live.')
})

// Codex review v4 #3: EOF without [DONE] must not look like a complete translation
test('translateTextStream: connection dropped mid-answer → error, remainder never emitted', async () => {
  const chunks = []
  const enc = new TextEncoder()
  const dropped = () => new Response(new ReadableStream({
    start(c) {
      for (const d of ['Transfer 500 ribu hari ini. ', 'Tapi jangan']) {
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`))
      }
      c.close() // no [DONE]
    }
  }), { status: 200 })
  await assert.rejects(
    withFetch(async () => dropped(), () => translateTextStream('今天转50万，但是别…', ZH, ID, 'k', '', undefined, 'gpt-6-luna', (c) => chunks.push(c))),
    /译文不完整/
  )
  assert.deepEqual(chunks, ['Transfer 500 ribu hari ini.'])
})

// Codex review v4 #2: a stream that goes silent must not hang the turn
test('translateTextStream: stalled stream → timeout error (watchdog)', async () => {
  const enc = new TextEncoder()
  const stalled = (url, init) => new Response(new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Besok ' } }] })}\n\n`))
      init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      // never closes
    }
  }), { status: 200 })
  const t0 = Date.now()
  await assert.rejects(
    withFetch(async (url, init) => stalled(url, init),
      () => translateTextStream('明天', ZH, ID, 'k', '', undefined, 'gpt-6-luna', () => {}, { firstByteMs: 200, idleMs: 50 })),
    /翻译超时/
  )
  assert.ok(Date.now() - t0 < 1000)
})

test('translateTextStream: in-stream error event → throws', async () => {
  const enc = new TextEncoder()
  await assert.rejects(
    withFetch(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(enc.encode('data: {"error":{"message":"server overloaded"}}\n\n')); c.close() }
    }), { status: 200 }), () => translateTextStream('明天', ZH, ID, 'k', '', undefined, 'gpt-6-luna', () => {})),
    /server overloaded/
  )
})

test('translateTextStream: HTTP error throws before any chunk (routing can fall back)', async () => {
  const chunks = []
  await assert.rejects(
    withFetch(async () => new Response(JSON.stringify({ error: { message: 'The model does not exist', code: 'model_not_found' } }), { status: 404 }),
      () => translateTextStream('明天', ZH, ID, 'k', '', undefined, 'gpt-6-luna', (c) => chunks.push(c))),
    (err) => err.status === 404 && err.code === 'model_not_found'
  )
  assert.deepEqual(chunks, [])
})
