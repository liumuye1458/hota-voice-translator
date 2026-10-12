import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectTextDirection } from '../textDirection.js'

test('Chinese text → zh→id', () => {
  assert.equal(detectTextDirection('明天早上九点开播，别迟到'), 'zh→id')
})

test('Indonesian text → id→zh', () => {
  assert.equal(detectTextDirection('Bu, mohon maaf saya besok tidak bisa masuk kerja karena sakit.'), 'id→zh')
})

test('English text → id→zh (any non-Chinese goes to Chinese)', () => {
  assert.equal(detectTextDirection('Please send the report by Friday.'), 'id→zh')
})

test('Chinese with a few Latin words / numbers stays zh→id', () => {
  assert.equal(detectTextDirection('今天直播GMV做到5000万Rp了吗'), 'zh→id')
})

test('Indonesian with one Chinese name stays id→zh', () => {
  assert.equal(detectTextDirection('Pak 王 bilang gaji bulan ini akan ditransfer hari Senin ya'), 'id→zh')
})

test('empty / whitespace defaults to zh→id', () => {
  assert.equal(detectTextDirection(''), 'zh→id')
  assert.equal(detectTextDirection('   \n'), 'zh→id')
  assert.equal(detectTextDirection(null), 'zh→id')
})
