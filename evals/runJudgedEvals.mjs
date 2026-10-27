#!/usr/bin/env node
// evals/runJudgedEvals.mjs — judged translation eval (PRD-003 §2.2)
//
// Runs the PRODUCTION translateText() on evals/translation-hard.json and has a
// stronger model grade each output 1-5 + "critical" (wrong amount/name/date/
// negation, or softened tone). String assertions (runEvals.mjs) can't grade
// these cases: many correct translations exist.
//
// Usage:
//   OPENAI_API_KEY=sk-... node evals/runJudgedEvals.mjs
//   OPENAI_API_KEY=sk-... node evals/runJudgedEvals.mjs --models gpt-6-luna,gpt-5.4-mini --reps 2 --set holdout
//
// Writes evals/history/judged-<timestamp>.json.

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { translateText } from '../src/services/openai.js'
import { getLangName } from '../src/config/languages.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) {
  console.error('ERROR: set OPENAI_API_KEY')
  process.exit(1)
}
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : dflt
}
const MODELS = arg('--models', 'gpt-6-luna').split(',').map(s => s.trim()).filter(Boolean)
const REPS = Number(arg('--reps', '2'))
const SET = arg('--set', 'all')
const JUDGE = arg('--judge', 'gpt-6-sol')

const CODE = { zh: 'zh-CN', id: 'id-ID' }
const JUDGE_SYSTEM = 'You are a strict professional Chinese↔Indonesian interpreter grading a translation for an Indonesian live-streaming company (boss ↔ staff). Score 1-5: 5 = fully faithful, natural, all facts exact; 4 = minor wording issue; 3 = noticeable meaning/terminology issue; 2 = a key fact wrong or missing; 1 = wrong. critical=true if any number, amount, date/time, name, negation or who-does-what is wrong/missing, or tone softened when the source is harsh. Return JSON {"score":n,"critical":bool,"why":"<15 words"}'

async function judge(tc, out) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: JUDGE,
      reasoning_effort: 'medium',
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: `Direction: ${tc.dir}\nSource: ${tc.text}\nKey facts the translation must carry: ${tc.facts}\nTranslation: ${out}` }
      ]
    })
  })
  const data = await res.json()
  try { return JSON.parse(data.choices[0].message.content) } catch { return { score: 0, critical: true, why: 'judge failed' } }
}

const suite = JSON.parse(await fs.readFile(path.join(__dirname, 'translation-hard.json'), 'utf8'))
const cases = suite.cases.filter(c => SET === 'all' || c.set === SET)
const report = { ranAt: new Date().toISOString(), judge: JUDGE, reps: REPS, set: SET, models: {} }

for (const model of MODELS) {
  const rows = []
  await Promise.all(cases.map(async (tc) => {
    const [s, t] = tc.dir.split('→')
    for (let rep = 0; rep < REPS; rep++) {
      const t0 = performance.now()
      let out = null, err = null
      try { out = await translateText(tc.text, getLangName(CODE[s]), getLangName(CODE[t]), apiKey, '', undefined, model) }
      catch (e) { err = e.message }
      const ms = Math.round(performance.now() - t0)
      const j = out ? await judge(tc, out) : { score: 0, critical: true, why: err }
      rows.push({ id: tc.id, set: tc.set, rep, ms, out, ...j })
    }
  }))
  const summary = {}
  for (const set of [...new Set(rows.map(r => r.set))]) {
    const rs = rows.filter(r => r.set === set)
    summary[set] = {
      avg: +(rs.reduce((a, r) => a + r.score, 0) / rs.length).toFixed(2),
      critical: rs.filter(r => r.critical).length,
      n: rs.length
    }
  }
  report.models[model] = { summary, rows: rows.sort((a, b) => a.id.localeCompare(b.id) || a.rep - b.rep) }
  console.log(model, JSON.stringify(summary))
  for (const r of rows.filter(r => r.critical || r.score <= 3)) {
    console.log(`   ${r.id}#${r.rep} [${r.score}${r.critical ? '!' : ''}] ${r.out}  // ${r.why}`)
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
await fs.mkdir(path.join(__dirname, 'history'), { recursive: true })
await fs.writeFile(path.join(__dirname, 'history', `judged-${stamp}.json`), JSON.stringify(report, null, 1))
