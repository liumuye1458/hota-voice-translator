#!/usr/bin/env node
// evals/runEvals.mjs
//
// Run translation golden tests against live OpenAI API.
//
// Usage:
//   OPENAI_API_KEY=sk-... node evals/runEvals.mjs translation
//   OPENAI_API_KEY=sk-... node evals/runEvals.mjs all
//
// Cost estimate per full run: ~$0.01 (20 calls × ~50 tokens × $2.50/1M)

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const OPENAI_API = 'https://api.openai.com/v1'
const apiKey = process.env.OPENAI_API_KEY
const mode = process.argv[2] || 'all'

if (!apiKey && mode !== 'fsm') {
  console.error('ERROR: Set OPENAI_API_KEY env var to run translation evals.')
  console.error('       FSM tests don\'t need a key — run: npm test')
  process.exit(1)
}

// Language-code → human-readable language name (for prompt)
const LANG_NAMES = {
  'zh': 'Chinese (Simplified, 简体中文)',
  'id': 'Indonesian (Bahasa Indonesia)',
  'en': 'English',
  'vi': 'Vietnamese (Tiếng Việt)',
  'th': 'Thai (ภาษาไทย)',
  'es': 'Spanish (Español)',
  'ru': 'Russian (Русский)',
  'ar': 'Arabic (العربية)'
}

function directionToLangs(direction) {
  // 'zh→id' → { source: 'Chinese...', target: 'Indonesian...' }
  const [src, tgt] = direction.split('→')
  return { source: LANG_NAMES[src] || src, target: LANG_NAMES[tgt] || tgt }
}

async function translate(text, sourceLang, targetLang) {
  const systemPrompt = `Translate the user's message from ${sourceLang} to ${targetLang}.

Rules:
- Output MUST be in ${targetLang}. Do not output ${sourceLang}. Do not output English unless ${targetLang} IS English.
- The input is a speech-to-text transcript; silently drop filler words ("嗯", "那个", "就是", "uh") and fix obvious mis-recognitions.
- Preserve the speaker's tone exactly. Do not soften criticism. Do not add politeness words that weren't in the original.
- Do not pad. Brief input → brief output.
- Output ONLY the translation. No quotes, no explanation, no labels.`

  const res = await fetch(`${OPENAI_API}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      temperature: 0,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text }
      ]
    })
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `HTTP ${res.status}`)
  }
  const data = await res.json()
  return {
    output: data.choices[0].message.content.trim(),
    usage: data.usage  // { prompt_tokens, completion_tokens, total_tokens }
  }
}

function assertCase(testCase, output) {
  const lower = output.toLowerCase()
  const failures = []
  // must_contain — at least one OR-style match for synonyms
  if (testCase.must_contain && testCase.must_contain.length > 0) {
    const containsAny = testCase.must_contain.some(needle => lower.includes(needle.toLowerCase()))
    // For multi-word must_contain (e.g. ["8", "link", "produk"]) — interpret as "ALL must appear"
    // BUT if a case has synonym alternatives marked in notes, allow OR. Default: ALL.
    const allRequired = testCase.must_contain.every(needle => lower.includes(needle.toLowerCase()))
    // Heuristic: if any item is multi-char and unique-looking (a name or specific term), require all.
    // For now, use ALL match (strict). User can mark notes for OR semantics.
    if (!allRequired) {
      const missing = testCase.must_contain.filter(needle => !lower.includes(needle.toLowerCase()))
      failures.push(`must_contain missing: [${missing.join(', ')}]`)
    }
  }
  if (testCase.must_not_contain && testCase.must_not_contain.length > 0) {
    const found = testCase.must_not_contain.filter(needle => lower.includes(needle.toLowerCase()))
    if (found.length > 0) {
      failures.push(`must_not_contain found: [${found.join(', ')}]`)
    }
  }
  return { passed: failures.length === 0, failures }
}

async function runTranslationEvals() {
  const goldenPath = path.join(ROOT, 'evals', 'translation-golden.json')
  const golden = JSON.parse(await fs.readFile(goldenPath, 'utf8'))

  console.log(`\n=== Translation Golden Evals (${golden.cases.length} cases) ===\n`)
  let passed = 0
  let failed = 0
  let totalInputTokens = 0
  let totalOutputTokens = 0
  const results = []

  for (const tc of golden.cases) {
    process.stdout.write(`  ${tc.id} (${tc.direction})... `)
    const { source, target } = directionToLangs(tc.direction)
    try {
      const { output, usage } = await translate(tc.input, source, target)
      totalInputTokens += usage.prompt_tokens
      totalOutputTokens += usage.completion_tokens
      const verdict = assertCase(tc, output)
      if (verdict.passed) {
        console.log('PASS')
        passed += 1
      } else {
        console.log('FAIL')
        console.log(`    input:  ${tc.input}`)
        console.log(`    output: ${output}`)
        for (const f of verdict.failures) console.log(`    issue:  ${f}`)
        failed += 1
      }
      results.push({ id: tc.id, passed: verdict.passed, input: tc.input, output, failures: verdict.failures })
    } catch (err) {
      console.log(`ERROR: ${err.message}`)
      failed += 1
      results.push({ id: tc.id, error: err.message })
    }
  }

  // Cost estimate (gpt-4o pricing: $2.50/1M input, $10/1M output)
  const costUSD = (totalInputTokens / 1e6 * 2.50) + (totalOutputTokens / 1e6 * 10)

  console.log(`\n=== Summary ===`)
  console.log(`  Passed: ${passed}/${golden.cases.length}`)
  console.log(`  Failed: ${failed}/${golden.cases.length}`)
  console.log(`  Tokens: ${totalInputTokens} in + ${totalOutputTokens} out`)
  console.log(`  Cost:   $${costUSD.toFixed(4)}`)
  console.log()

  // Write history
  const histDir = path.join(ROOT, 'evals', 'history')
  await fs.mkdir(histDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const histFile = path.join(histDir, `${timestamp}.json`)
  await fs.writeFile(histFile, JSON.stringify({
    timestamp,
    passed,
    failed,
    total: golden.cases.length,
    tokens: { in: totalInputTokens, out: totalOutputTokens },
    costUSD,
    results
  }, null, 2))
  console.log(`  History: evals/history/${timestamp}.json`)

  return failed === 0
}

async function runFSMEvals() {
  console.log('\n=== FSM Integration Tests ===')
  console.log('  (run via: npm test)')
  console.log()
}

// Main
;(async () => {
  try {
    if (mode === 'translation' || mode === 'all') {
      const ok = await runTranslationEvals()
      if (!ok) process.exit(1)
    }
    if (mode === 'fsm' || mode === 'all') {
      await runFSMEvals()
    }
    if (!['translation', 'fsm', 'all'].includes(mode)) {
      console.error(`Unknown mode: ${mode}. Use: translation | fsm | all`)
      process.exit(1)
    }
  } catch (err) {
    console.error('FATAL:', err.message)
    process.exit(1)
  }
})()
