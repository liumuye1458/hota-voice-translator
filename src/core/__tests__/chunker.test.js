// src/core/__tests__/chunker.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { split } from '../sentenceChunker.js'

test('empty / whitespace input → empty array', () => {
  assert.deepEqual(split(''), [])
  assert.deepEqual(split('   '), [])
  assert.deepEqual(split('\n\n'), [])
  assert.deepEqual(split(null), [])
  assert.deepEqual(split(undefined), [])
})

test('short text fits in single chunk', () => {
  assert.deepEqual(split('Hello world'), ['Hello world'])
  assert.deepEqual(split('明天 8 点直播'), ['明天 8 点直播'])
})

test('text exactly at maxChars → single chunk', () => {
  const text = 'a'.repeat(100)
  assert.deepEqual(split(text, { maxChars: 100 }), [text])
})

test('text just over maxChars splits at word boundary', () => {
  // 101 chars: "aaaa...a a" — last space lets us split there
  const text = 'a'.repeat(99) + ' bb'
  const chunks = split(text, { maxChars: 100 })
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].length <= 100, true)
  assert.equal(chunks[1], 'bb')
})

test('Chinese sentence boundaries take priority', () => {
  const text = '第一句话。第二句话，包含逗号。第三句话！'.repeat(30) // ~600 chars
  const chunks = split(text, { maxChars: 100 })
  // Every chunk should end at 。 or ！ (no chunk should end mid-sentence)
  for (const c of chunks) {
    const last = c.slice(-1)
    assert.match(last, /[。！？]/, `chunk ends with: "${c.slice(-10)}"`)
  }
})

test('decimal numbers do NOT split at period', () => {
  // "3.14" should never be split between 3 and .14
  const sentence = 'GMV 达到 3.14 juta IDR。'
  const text = sentence.repeat(50) // ~1000 chars
  const chunks = split(text, { maxChars: 200 })
  for (const c of chunks) {
    assert.equal(c.includes('3.14'), true, 'decimal 3.14 must remain intact')
    assert.equal(c.endsWith('.'), false, 'no chunk should end with a stray period')
  }
})

test('currency with dots stays intact', () => {
  const text = 'Harga produk Rp 1.500.000 dan Rp 2.750.000 sangat menarik. '.repeat(40)
  const chunks = split(text, { maxChars: 200 })
  for (const c of chunks) {
    // Numbers like 1.500.000 must not be broken
    assert.equal(/Rp\s*1\.500\.000/.test(c) || !/Rp\s*1/.test(c), true,
      'currency formatting must stay intact within a chunk')
  }
})

test('single long sentence with no punctuation falls back to word boundary', () => {
  // 500 chars, no sentence punctuation, only spaces
  const text = ('hello world ' .repeat(50)).trim() // ~600 chars
  const chunks = split(text, { maxChars: 200 })
  assert.equal(chunks.length >= 3, true)
  // No chunk should be longer than maxChars
  for (const c of chunks) {
    assert.equal(c.length <= 200, true, `chunk too long: ${c.length}`)
  }
})

test('hard cut as worst case (no boundaries at all)', () => {
  const text = 'a'.repeat(500) // no spaces, no punctuation
  const chunks = split(text, { maxChars: 100 })
  assert.equal(chunks.length, 5)
  for (const c of chunks) {
    assert.equal(c.length <= 100, true)
  }
})

test('paragraph breaks are honored', () => {
  const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
  const chunks = split(text, { maxChars: 25 })
  // Should split at \n\n boundaries
  assert.equal(chunks.length, 3)
})

test('mixed Chinese + English + numbers', () => {
  const text = '昨天 GMV 达到 1.5 juta，今天目标 2.0 juta. 加油！'
  const chunks = split(text)
  // Short text → single chunk
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0], text.trim())
})

test('emoji at boundaries does not break chunking', () => {
  const text = '直播开始啦 🎉。今天的产品很棒 ❤️。一起来看 👀！'.repeat(20)
  const chunks = split(text, { maxChars: 80 })
  // Just verify no crashes and chunks are reasonable
  for (const c of chunks) {
    assert.equal(c.length > 0, true)
    assert.equal(c.length <= 80, true)
  }
})

test('default 3200 char budget — 4000 char text → 2 chunks', () => {
  const sentence = '这是一个完整的句子，包含足够多的字符来填满空间。'  // ~24 chars
  const text = sentence.repeat(170) // ~4000 chars
  const chunks = split(text)
  assert.equal(chunks.length, 2)
  for (const c of chunks) {
    assert.equal(c.length <= 3200, true, `chunk exceeds default budget: ${c.length}`)
  }
})

test('trailing whitespace is trimmed from chunks', () => {
  const text = 'Hello.   '.repeat(50)
  const chunks = split(text, { maxChars: 30 })
  for (const c of chunks) {
    assert.equal(c, c.trim(), 'chunk should not have leading/trailing whitespace')
  }
})

test('one giant URL with no breaks falls back to hard cut', () => {
  const text = 'https://' + 'a'.repeat(5000) + '.com'
  const chunks = split(text, { maxChars: 1000 })
  assert.equal(chunks.length >= 5, true)
  for (const c of chunks) {
    assert.equal(c.length <= 1000, true)
  }
})

test('exactly the 4096 boundary (real OpenAI limit) — guard rail', () => {
  // Build text that is exactly 4096 chars
  const sentence = '业务进展正常。' // 7 chars
  const text = sentence.repeat(585) // = 4095 chars
  assert.equal(text.length, 4095)
  const chunks = split(text, { maxChars: 3200 })
  // Verify no chunk exceeds 3200 (our budget; OpenAI would accept up to 4096)
  for (const c of chunks) {
    assert.equal(c.length <= 3200, true)
  }
})
