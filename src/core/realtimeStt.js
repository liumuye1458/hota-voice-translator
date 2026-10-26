// src/core/realtimeStt.js — ADR-005
//
// Stream mic audio to OpenAI Realtime transcription while the button is held,
// so release only waits for the last fragment instead of a whole-clip upload.
//
// Core invariant: this module never decides the final outcome on failure.
// finish() returns {ok:false, reason} and the caller falls back to uploading
// the MediaRecorder clip (v3 path). It never throws.
//
// Browser-free core: WebSocket, capture and secret source are injected so the
// whole lifecycle is unit-testable in Node.

import { Resampler, floatToPcm16, bytesToBase64 } from './pcm.js'

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime'
const RATE = 24000
const BATCH_SAMPLES = 2400          // ~100 ms per append
const MIN_COMMIT_SAMPLES = 2400     // server rejects commits < 100 ms

// Resolve with `promise`, or with `fallback` after ms (the promise keeps running).
function withTimeout(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) })
  ]).finally(() => clearTimeout(timer))
}

/** Session config for /v1/realtime/client_secrets. */
export function transcriptionSessionConfig({ model, language, prompt }) {
  return {
    type: 'transcription',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: RATE },
        transcription: { model, ...(language ? { language } : {}), ...(prompt ? { prompt } : {}) },
        turn_detection: null
      }
    }
  }
}

export class RealtimeTranscriber {
  /**
   * @param {object} deps
   * @param {() => Promise<string>} deps.getSecret  ephemeral client secret
   * @param {(stream: MediaStream, onFrame: (f32: Float32Array, rate: number) => void) => Promise<{stop: () => Promise<void>|void}>} deps.createCapture
   * @param {typeof WebSocket} [deps.WebSocketImpl]
   * @param {number} [deps.commitTimeoutMs]   commit → transcript deadline
   * @param {number} [deps.captureReadyTimeoutMs]  release waits at most this long for capture setup
   * @param {number} [deps.lateStartMs]       capture ready later than this after start() →
   *   the opening words were only in the MediaRecorder clip, so use upload instead
   */
  constructor({
    getSecret, createCapture, WebSocketImpl = globalThis.WebSocket, url = REALTIME_URL, now,
    commitTimeoutMs = 3500, captureReadyTimeoutMs = 800, lateStartMs = 150
  }) {
    this._getSecret = getSecret
    this._createCapture = createCapture
    this._WS = WebSocketImpl
    this._timeoutMs = commitTimeoutMs
    this._captureReadyTimeoutMs = captureReadyTimeoutMs
    this._lateStartMs = lateStartMs
    this._url = url
    this._now = now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()))

    this.state = 'idle'          // idle → connecting → open | failed → closed
    this.failReason = null
    this.samples = 0             // total 24 kHz samples captured
    this.partial = ''            // live transcript deltas (for UI / logs)
    this.lateStart = false
    this.timings = {}

    this._ws = null
    this._capture = null
    this._capturePromise = null
    this._resampler = null
    this._batch = []
    this._batchLen = 0
    this._queue = []             // base64 appends waiting for the socket
    this._result = null          // resolver for the committed transcript
    this._closed = false
  }

  /** Begin capture + connection. Returns immediately; failures surface in finish(). */
  start(stream) {
    if (this.state !== 'idle') return
    this.state = 'connecting'
    this.timings.start = this._now()

    this._capturePromise = Promise.resolve()
      .then(() => this._createCapture(stream, (f32, rate) => this._onFrame(f32, rate)))
      .then((cap) => {
        if (this._closed) { try { cap.stop() } catch { /* ignore */ } return }
        this._capture = cap
        this.timings.captureReady = this._now()
        if (this.timings.captureReady - this.timings.start > this._lateStartMs) this.lateStart = true
      })
      .catch((err) => this._fail('capture: ' + (err?.message || err)))

    Promise.resolve()
      .then(() => this._getSecret())
      .then((secret) => {
        if (this._closed) return
        this.timings.secret = this._now()
        const ws = new this._WS(this._url, ['realtime', 'openai-insecure-api-key.' + secret])
        this._ws = ws
        ws.onopen = () => {
          if (this._closed) return
          this.timings.open = this._now()
          this.state = 'open'
          for (const audio of this._queue) this._send({ type: 'input_audio_buffer.append', audio })
          this._queue = []
        }
        ws.onmessage = (ev) => this._onMessage(ev)
        ws.onerror = () => this._fail('socket-error')
        ws.onclose = (ev) => this._fail('socket-closed-' + (ev?.code ?? ''))
      })
      .catch((err) => this._fail('secret: ' + (err?.status || '') + ' ' + (err?.message || err)))
  }

  /**
   * Stop capturing and get the transcript.
   * @returns {Promise<{ok: true, text: string} | {ok: false, reason: string}>}
   */
  async finish() {
    this.timings.release = this._now()
    // Let a pending capture setup settle (bounded: AudioContext.resume() may
    // never resolve outside a gesture), then stop it so the last frames arrive.
    const ready = await withTimeout(this._capturePromise.then(() => true), this._captureReadyTimeoutMs, false)
    if (!ready) return this._done({ ok: false, reason: 'capture-not-ready' })
    await withTimeout(Promise.resolve().then(() => this._capture?.stop()).catch(() => {}), 300, null)
    this._flushBatch()

    if (this.state === 'failed') return this._done({ ok: false, reason: this.failReason })
    if (this.lateStart) return this._done({ ok: false, reason: 'capture-started-late' })
    if (this.samples < MIN_COMMIT_SAMPLES) return this._done({ ok: false, reason: 'no-audio-captured' })
    if (this.state !== 'open') return this._done({ ok: false, reason: 'not-connected-at-release' })

    const result = new Promise((resolve) => { this._result = resolve })
    this._send({ type: 'input_audio_buffer.commit' })
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, reason: 'commit-timeout' }), this._timeoutMs)
    })
    const out = await Promise.race([result, timeout])
    clearTimeout(timer)
    if (out.ok && !out.text.trim()) return this._done({ ok: false, reason: 'empty-transcript' })
    return this._done(out)
  }

  /** Tear everything down. Idempotent. */
  close() {
    if (this._closed) return
    this._closed = true
    if (this.state !== 'failed') this.state = 'closed'
    try { this._capture?.stop() } catch { /* ignore */ }
    const ws = this._ws
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
      try { ws.close() } catch { /* ignore */ }
    }
    this._result?.({ ok: false, reason: 'closed' })
  }

  // ---- internals -------------------------------------------------------

  _done(out) {
    this.timings.final = this._now()
    this.close()
    return out
  }

  _fail(reason) {
    if (this._closed || this.state === 'failed') return
    this.state = 'failed'
    this.failReason = reason
    this._result?.({ ok: false, reason })
  }

  _onFrame(f32, rate) {
    if (this._closed) return
    if (!this._resampler) this._resampler = new Resampler(rate, RATE)
    const out = this._resampler.process(f32)
    if (!out.length) return
    this._batch.push(out)
    this._batchLen += out.length
    if (this._batchLen >= BATCH_SAMPLES) this._flushBatch()
  }

  _flushBatch() {
    if (!this._batchLen) return
    const all = new Float32Array(this._batchLen)
    let o = 0
    for (const part of this._batch) { all.set(part, o); o += part.length }
    this.samples += all.length
    this._batch = []
    this._batchLen = 0
    const audio = bytesToBase64(floatToPcm16(all))
    if (this.state === 'open') this._send({ type: 'input_audio_buffer.append', audio })
    else if (this.state === 'connecting') this._queue.push(audio)
  }

  _send(obj) {
    try { this._ws?.send(JSON.stringify(obj)) } catch (err) { this._fail('send: ' + (err?.message || err)) }
  }

  _onMessage(ev) {
    let e
    try { e = JSON.parse(ev.data) } catch { return }
    const type = e.type || ''
    if (type.endsWith('input_audio_transcription.delta')) {
      if (!this.timings.firstDelta) this.timings.firstDelta = this._now()
      this.partial += e.delta || ''
    } else if (type.endsWith('input_audio_transcription.completed')) {
      this._result?.({ ok: true, text: e.transcript || '' })
    } else if (type.endsWith('input_audio_transcription.failed')) {
      this._fail('transcription-failed: ' + (e.error?.message || ''))
    } else if (type === 'error') {
      this._fail('server-error: ' + (e.error?.message || ''))
    }
  }
}

// ===== Browser capture (AudioWorklet) =====================================

const WORKLET_SRC = `
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

let captureCtxPromise = null
let captureCtx = null      // same context, for synchronous resume() inside a gesture

// One AudioContext + loaded worklet for the page; warming it on first press
// means later presses lose no leading audio to setup time.
function getCaptureContext() {
  if (!captureCtxPromise) {
    captureCtxPromise = (async () => {
      const ctx = new AudioContext()
      captureCtx = ctx
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
      try {
        await ctx.audioWorklet.addModule(url)
      } catch (err) {
        captureCtx = null
        try { await ctx.close() } catch { /* ignore */ }
        throw err
      } finally {
        URL.revokeObjectURL(url)
      }
      return ctx
    })().catch((err) => { captureCtxPromise = null; throw err })
  }
  return captureCtxPromise
}

/**
 * Create the capture context, or resume it if the browser suspended it
 * (iOS does after interruptions). MUST be called synchronously inside a user
 * gesture — resume() outside one may never resolve. Never throws.
 */
export function warmCapture() {
  if (typeof AudioContext === 'undefined' || typeof AudioWorkletNode === 'undefined') return
  if (captureCtx && captureCtx.state !== 'running' && captureCtx.state !== 'closed') {
    captureCtx.resume().catch(() => {})
  }
  getCaptureContext().catch(() => {})
}

/** Default createCapture for the browser. */
export async function createWorkletCapture(stream, onFrame) {
  if (typeof AudioWorkletNode === 'undefined') throw new Error('AudioWorklet unsupported')
  const ctx = await getCaptureContext()
  if (ctx.state !== 'running') {
    await withTimeout(ctx.resume().catch(() => {}), 300, null)
    if (ctx.state !== 'running') throw new Error('audio context ' + ctx.state)
  }
  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-tap')
  const mute = ctx.createGain()
  mute.gain.value = 0
  node.port.onmessage = (e) => onFrame(e.data, ctx.sampleRate)
  src.connect(node)
  node.connect(mute)       // keep the node pulled by the graph without making sound
  mute.connect(ctx.destination)
  let stopped = false
  return {
    async stop() {
      if (stopped) return
      stopped = true
      // Give the worklet one render quantum to post its last frame
      await new Promise((r) => setTimeout(r, 30))
      node.port.onmessage = null
      try { src.disconnect() } catch { /* ignore */ }
      try { node.disconnect() } catch { /* ignore */ }
      try { mute.disconnect() } catch { /* ignore */ }
    }
  }
}

// ===== Secret cache ========================================================

/**
 * Reusable ephemeral secrets keyed by (apiKey, session config). Secrets are
 * valid ~10 min and reusable (verified 2026-10-27); treat as stale 60 s early.
 */
export class SecretCache {
  constructor(mint, { now = () => Date.now(), marginMs = 60000 } = {}) {
    this._mint = mint
    this._now = now
    this._margin = marginMs
    this._entries = new Map()
  }

  get(apiKey, config) {
    const k = apiKey + '|' + JSON.stringify(config)
    const hit = this._entries.get(k)
    if (hit?.value && hit.expiresAt - this._margin > this._now()) return Promise.resolve(hit.value)
    if (hit?.inflight) return hit.inflight
    const inflight = this._mint(apiKey, config)
      .then(({ value, expiresAt }) => {
        this._entries.set(k, { value, expiresAt: expiresAt || this._now() + 9 * 60000 })
        return value
      })
      .catch((err) => { this._entries.delete(k); throw err })
    this._entries.set(k, { inflight })
    return inflight
  }

  /** Fire-and-forget warmup; errors are swallowed (start() will retry). */
  prewarm(apiKey, config) {
    this.get(apiKey, config).catch(() => {})
  }

  clear() { this._entries.clear() }
}
