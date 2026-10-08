// src/core/modelRouter.js — PRD-002 §5.1
//
// Error classification + sticky model fallback for translation calls.
// Pure module: no React, no DOM, no fetch. Unit-tested in __tests__/modelRouter.test.js.

export const TRANSLATION_MODELS = Object.freeze([
  { id: 'gpt-6-luna', label: 'GPT-6 Luna（默认）' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gpt-4o', label: 'GPT-4o（v2 旧版）' }
])

export const STT_MODELS = Object.freeze([
  { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe（默认）' },
  { id: 'gpt-transcribe', label: 'gpt-transcribe（新，待 A/B 验证）' }
])

export const DEFAULT_TRANSLATION_MODEL = 'gpt-6-luna'
export const DEFAULT_STT_MODEL = 'gpt-4o-transcribe'

// Only these models have an automatic fallback target.
const FALLBACK_OF = Object.freeze({
  'gpt-6-luna': 'gpt-5.4-mini'
})

// Must describe access/existence, not merely mention "model": e.g.
// "'temperature' does not support 0 with this model" is a parameter bug.
const CAPABILITY_MESSAGE = /does not exist|do(es)? not have access|model[^.]*not found|not available (to|for) (you|your)/i
const CAPABILITY_429 = /quota|tier/i

/**
 * Classify an error from an OpenAI call.
 *
 * @returns {'aborted'|'network'|'auth'|'capability'|'transient'|'request'}
 *   aborted    — caller cancelled; never retry, never fall back
 *   network    — fetch threw (no HTTP status); fail this call only
 *   auth       — 401/403 key problem; tell the user to fix the key
 *   capability — this model can't be used with this key → sticky fallback
 *   transient  — 5xx or plain rate limit → retry once, no fallback
 *   request    — other 4xx; fail this call only
 */
export function classifyError(err) {
  if (!err) return 'request'
  if (err.name === 'AbortError') return 'aborted'
  const status = err.status ?? null
  const msg = `${err.code || ''} ${err.message || ''}`
  if (status == null) return 'network'
  if (err.code === 'model_not_found') return 'capability'
  if (status === 401 || status === 403) return 'auth'
  // A rejected request parameter is our bug, never a reason to switch models
  if (status === 400 && err.param && err.param !== 'model') return 'request'
  if ((status === 400 || status === 404) && CAPABILITY_MESSAGE.test(msg)) return 'capability'
  if (status === 429) return CAPABILITY_429.test(msg) ? 'capability' : 'transient'
  if (status >= 500) return 'transient'
  return 'request'
}

/**
 * Holds the user's preferred translation model plus the in-memory
 * "downgraded this page session" flag. Recreate (or call reset()) when the
 * user changes the model in Settings or presses "recheck".
 */
export class TranslationModelRouter {
  constructor(preferred = DEFAULT_TRANSLATION_MODEL) {
    this.preferred = preferred
    this.downgraded = false
    this.lastFallback = null
  }

  currentModel() {
    return this.downgraded ? FALLBACK_OF[this.preferred] : this.preferred
  }

  canFallback() {
    return !this.downgraded && Boolean(FALLBACK_OF[this.preferred])
  }

  /** Mark preferred model unusable for the rest of this page session. */
  markCapabilityFailure(err) {
    this.downgraded = true
    this.lastFallback = {
      from: this.preferred,
      to: FALLBACK_OF[this.preferred],
      reason: classifyError(err),
      status: err?.status ?? null,
      message: err?.message || ''
    }
    return this.lastFallback
  }

  reset() {
    this.downgraded = false
    this.lastFallback = null
  }
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Run `call(model)` under the router's policy:
 *   - transient → retry the same model once after 1s
 *   - capability → sticky-downgrade (if a fallback exists) and run on fallback
 *   - everything else → rethrow
 *
 * @param {TranslationModelRouter} router
 * @param {(model: string) => Promise<any>} call
 * @param {{ sleep?: (ms:number)=>Promise<void>, onFallback?: (ev)=>void }} [opts]
 * @returns {Promise<{ result: any, model: string, fellBack: boolean }>}
 */
export async function runWithModelRouting(router, call, opts = {}) {
  const sleep = opts.sleep || defaultSleep

  const attempt = async (model) => {
    try {
      return await call(model)
    } catch (err) {
      if (classifyError(err) !== 'transient') throw err
      await sleep(1000)
      return await call(model)
    }
  }

  const model = router.currentModel()
  try {
    return { result: await attempt(model), model, fellBack: false }
  } catch (err) {
    if (classifyError(err) !== 'capability' || !router.canFallback()) throw err
    const ev = router.markCapabilityFailure(err)
    opts.onFallback?.(ev)
    const fb = router.currentModel()
    return { result: await attempt(fb), model: fb, fellBack: true }
  }
}
