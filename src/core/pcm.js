// src/core/pcm.js — ADR-005
//
// Pure audio helpers for realtime STT: resample the mic's Float32 frames
// (usually 48 kHz) to 24 kHz mono and encode as base64 PCM16 little-endian,
// the format the Realtime API expects for audio/pcm @ 24000.

/**
 * Streaming linear resampler. Keeps fractional position + last sample
 * between calls so consecutive frames join without clicks or drift.
 */
export class Resampler {
  constructor(inRate, outRate = 24000) {
    this.ratio = inRate / outRate
    this.pos = 0          // fractional read position into the virtual stream (relative to current frame)
    this.prev = 0         // last sample of the previous frame (index -1)
  }

  /** @param {Float32Array} input @returns {Float32Array} */
  process(input) {
    if (this.ratio === 1) return Float32Array.from(input)
    const out = []
    // Virtual stream: [prev, ...input]; position p maps to input[p] with input[-1] = prev
    let p = this.pos
    while (p <= input.length - 1) {
      const i = Math.floor(p)
      const frac = p - i
      const a = i < 0 ? this.prev : input[i]
      const b = input[i + 1] ?? input[i]
      out.push(a + (b - a) * frac)
      p += this.ratio
    }
    this.pos = p - input.length
    if (input.length) this.prev = input[input.length - 1]
    return Float32Array.from(out)
  }
}

/** Float32 [-1, 1] → Int16 PCM bytes (little-endian). */
export function floatToPcm16(float32) {
  const buf = new ArrayBuffer(float32.length * 2)
  const view = new DataView(buf)
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Uint8Array(buf)
}

export function bytesToBase64(bytes) {
  let bin = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
  }
  return btoa(bin)
}
