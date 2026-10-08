#!/usr/bin/env node
// evals/runEvals.mjs — translation golden evals (PRD-002 §6)
//
// Uses the PRODUCTION translateText() so the eval tests exactly what users run.
//
// Usage:
//   OPENAI_API_KEY=sk-... node evals/runEvals.mjs
//   OPENAI_API_KEY=sk-... node evals/runEvals.mjs --models gpt-6-luna,gpt-5.4-mini,gpt-4o
//
// Writes evals/history/<timestamp>.json with every output for later diffing.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translateText } from '../src/services/openai.js'
import { getLangName } from '../src/config/languages.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('ERROR: set OPENAI_API_KEY. (FSM / unit tests need no key: npm test)')
  process.exit(1)
}

const modelsArg = process.argv.indexOf('--models')
const MODELS = modelsArg > -1
  ? process.argv[modelsArg + 1].split(',').map(s => s.trim()).filter(Boolean)
  : ['gpt-6-luna']

const CODE = { zh: 'zh-CN', id: 'id-ID', en: 'en-US', vi: 'vi-VN', th: 'th-TH', es: 'es-ES', ru: 'ru-RU', ar: 'ar-SA' }
function langsFor(direction) {
  const [src, tgt] = direction.split('→')
  return { source: getLangName(CODE[src]), target: getLangName(CODE[tgt]) }
}

export function assertCase(tc, output) {
  const lower = output.toLowerCase()
  const has = (s) => lower.includes(String(s).toLowerCase())
  const failures = []

  const missing = (tc.must_contain || []).filter(s => !has(s))
  if (missing.length) failures.push(`missing: [${missing.join(', ')}]`)

  const any = tc.must_contain_any || []
  const groups = any.length && Array.isArray(any[0]) ? any : (any.length ? [any] : [])
  for (const g of groups) {
    if (!g.some(has)) failures.push(`none of: [${g.join(' | ')}]`)
  }

  const forbidden = (tc.must_not_contain || []).filter(has)
  if (forbidden.length) failures.push(`forbidden: [${forbidden.join(', ')}]`)

  return { passed: failures.length === 0, failures }
}

async function runOne(tc, model) {
  const { source, target } = langsFor(tc.direction)
  const t0 = Date.now()
  try {
    const output = await translateText(tc.input, source, target, apiKey, '', undefined, model)
    return { output, ms: Date.now() - t0, ...assertCase(tc, output) }
  } catch (err) {
    return { output: null, ms: Date.now() - t0, passed: false, failures: [`ERROR ${err.status ?? ''} ${err.message}`] }
  }
}

const golden = JSON.parse(await fs.readFile(path.join(__dirname, 'translation-golden.json'), 'utf8'))
console.log(`\nTranslation golden evals — ${golden.cases.length} cases × ${MODELS.length} model(s): ${MODELS.join(', ')}\n`)

const results = {}
for (const m of MODELS) results[m] = []

for (const tc of golden.cases) {
  const outs = await Promise.all(MODELS.map(m => runOne(tc, m)))
  const marks = outs.map((o, i) => `${MODELS[i]}=${o.passed ? 'PASS' : 'FAIL'}`).join('  ')
  console.log(`${tc.id.padEnd(18)} ${marks}`)
  outs.forEach((o, i) => {
    results[MODELS[i]].push({ id: tc.id, input: tc.input, ...o })
    if (!o.passed) {
      console.log(`    [${MODELS[i]}] ${o.output ?? '(no output)'}`)
      for (const f of o.failures) console.log(`      - ${f}`)
    }
  })
}

console.log('\nSummary')
for (const m of MODELS) {
  const rs = results[m]
  const pass = rs.filter(r => r.passed).length
  const avgMs = Math.round(rs.reduce((a, r) => a + r.ms, 0) / rs.length)
  console.log(`  ${m.padEnd(16)} ${pass}/${rs.length} passed   avg ${avgMs} ms`)
}

const histDir = path.join(__dirname, 'history')
await fs.mkdir(histDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await fs.writeFile(path.join(histDir, `${stamp}.json`), JSON.stringify({ stamp, models: MODELS, results }, null, 2))
console.log(`\nSaved evals/history/${stamp}.json`)
