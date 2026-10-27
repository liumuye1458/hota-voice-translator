// src/core/chunkFeed.js — PRD-003 §3.1
//
// An append-only list of TTS text chunks that may still be growing while the
// translation streams. audioEngine reads it with get(i); the translator pushes
// chunks and finally calls end(). A plain array is wrapped with ChunkFeed.from().

export class ChunkFeed {
  constructor() {
    this.items = []
    this.ended = false
    this._waiters = []
  }

  static from(chunks) {
    const feed = new ChunkFeed()
    for (const c of chunks || []) feed.push(c)
    feed.end()
    return feed
  }

  push(text) {
    if (this.ended) return
    const t = String(text ?? '').trim()
    if (!t) return
    this.items.push(t)
    this._wake()
  }

  /** No more chunks will come (success, failure or cancel). Idempotent. */
  end() {
    if (this.ended) return
    this.ended = true
    this._wake()
  }

  /** Number of chunks once ended, else null (unknown yet). */
  get total() {
    return this.ended ? this.items.length : null
  }

  /**
   * Chunk i once available; null when the feed ended without it or the
   * signal aborts while waiting.
   * @returns {Promise<string|null>}
   */
  get(i, signal) {
    if (i < this.items.length) return Promise.resolve(this.items[i])
    if (this.ended || signal?.aborted) return Promise.resolve(null)
    return new Promise((resolve) => {
      const waiter = () => {
        if (i < this.items.length) { cleanup(); resolve(this.items[i]); return true }
        if (this.ended) { cleanup(); resolve(null); return true }
        return false
      }
      const onAbort = () => { cleanup(); resolve(null) }
      const cleanup = () => {
        this._waiters = this._waiters.filter(w => w !== waiter)
        signal?.removeEventListener('abort', onAbort)
      }
      this._waiters.push(waiter)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  _wake() {
    for (const w of [...this._waiters]) w()
  }
}
