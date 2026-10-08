// src/hooks/useTranslator.js — v2.0 React adapter
//
// Bridges the pure FSM core (sessionManager + translatorFSM) to React.
// Owns all side effects: API calls, MediaRecorder, audio playback.
// Reducer/sessionManager remain pure; this hook coordinates the dance.
//
// PRINCIPLE: every async side effect captures the session at start time.
// On resolution, dispatch event carrying (sessionId, attemptId).
// The reducer's stale-rejection filter ensures late callbacks are no-ops.

import { useReducer, useRef, useEffect, useCallback } from 'react'
import { reducer, initialState, STATES, shouldAutoReset } from '../core/translatorFSM.js'
import { sessionManager } from '../core/sessionManager.js'
import { audioEngine } from '../core/audioEngine.js'
import { split as splitChunks } from '../core/sentenceChunker.js'
import { translateText, transcribeAudio } from '../services/openai.js'
import { OpenAIStandardTTS } from '../core/ttsProvider.js'
import {
  TranslationModelRouter,
  runWithModelRouting,
  classifyError,
  DEFAULT_TRANSLATION_MODEL,
  DEFAULT_STT_MODEL
} from '../core/modelRouter.js'

// Language-name resolver. Used to build the prompt.
// Imports from config; if unavailable, fall back to literal codes.
import { getLangName, SOURCE_LANG, LANGUAGES } from '../config/languages.js'

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/mpeg'
]

/**
 * useTranslator({apiKey, voice, customInstructions, targetLangCode, sttPrompt, onTranslationDone, onError})
 *
 * Returns:
 *   state — { status, session, speakProgress, lastError, ... }
 *   sendText(text) — text-mode translation (Chinese → target)
 *   startVoice(side) — begin voice recording (side: 'left' | 'right')
 *   stopVoice() — release; process recorded audio
 *   cancelVoice() — cancel current recording without processing
 *   forceReset(reason) — nuclear cleanup
 */
export function useTranslator(opts) {
  const {
    apiKey,
    voice = 'nova',
    customInstructions = '',
    targetLangCode = 'id-ID',
    sttPrompt = '',
    translationModel = DEFAULT_TRANSLATION_MODEL,
    sttModel = DEFAULT_STT_MODEL,
    onTranslationDone,
    onModelFallback,
    onError
  } = opts

  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  // Stable refs to latest values for use inside async callbacks
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])

  // Sticky translation-model fallback (PRD-002 §5.1). A new router — i.e. a
  // cleared downgrade — whenever the user picks a different model in Settings.
  const routerRef = useRef(new TranslationModelRouter(translationModel))
  useEffect(() => {
    routerRef.current = new TranslationModelRouter(translationModel)
  }, [translationModel])

  // "重新检测" in Settings: forget this page session's downgrade
  const resetModelRouting = useCallback(() => {
    routerRef.current.reset()
  }, [])

  // Translate under the routing policy and record which model actually answered.
  const translateRouted = useCallback(async (session, text, sourceLangName, targetLangName, signal) => {
    const { result, model } = await runWithModelRouting(
      routerRef.current,
      (m) => translateText(text, sourceLangName, targetLangName, apiKey, customInstructions, signal, m),
      {
        onFallback: (ev) => {
          session.metrics.fallback_triggered = true
          console.info('translation_model_fallback', ev)
          optsRef.current.onModelFallback?.(ev)
        }
      }
    )
    session.metrics.model_translation = model
    return result
  }, [apiKey, customInstructions])

  // MediaRecorder state (kept here to allow cleanup from forceReset)
  const recorderStateRef = useRef({
    recorder: null,
    chunks: [],
    mimeType: null,
    stream: null
  })

  // Recovery timer for error → idle (3s)
  const recoveryTimerRef = useRef(null)
  useEffect(() => {
    if (state.status === STATES.ERROR) {
      if (!recoveryTimerRef.current) {
        recoveryTimerRef.current = setTimeout(() => {
          recoveryTimerRef.current = null
          dispatch({ type: 'RECOVER' })
        }, 3000)
      }
    } else if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
    }
    return () => {
      if (recoveryTimerRef.current) {
        clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
    }
  }, [state.status])

  // Auto-reset when error burst threshold crossed
  useEffect(() => {
    if (shouldAutoReset(state)) {
      console.warn('[useTranslator] auto-reset due to repeated errors')
      forceReset('error-burst')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.errorBurst.length])

  // ====================================================================
  // Force reset — drain everything
  // ====================================================================
  const forceReset = useCallback((reason = 'user') => {
    // 1. Cancel all sessions (aborts fetches, stops recorder, stops tracks, revokes URLs)
    sessionManager.cancelAll(reason)

    // 2. Stop audio playback
    audioEngine.stop()

    // 3. Clear any local recorder state
    const rs = recorderStateRef.current
    if (rs.recorder) {
      try { rs.recorder.ondataavailable = null } catch {}
      try { rs.recorder.onerror = null } catch {}
      try { rs.recorder.onstop = null } catch {}
      try {
        if (rs.recorder.state !== 'inactive') rs.recorder.stop()
      } catch {}
    }
    if (rs.stream) {
      try { rs.stream.getTracks().forEach(t => t.stop()) } catch {}
    }
    recorderStateRef.current = { recorder: null, chunks: [], mimeType: null, stream: null }

    // 4. Clear recovery timer
    if (recoveryTimerRef.current) {
      clearTimeout(recoveryTimerRef.current)
      recoveryTimerRef.current = null
    }

    // 5. Reset reducer
    dispatch({ type: 'RESET', reason })
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => forceReset('unmount')
  }, [forceReset])

  // ====================================================================
  // TEXT mode — Chinese → target
  // ====================================================================
  const sendText = useCallback(async (text) => {
    const cleaned = (text || '').trim()
    if (!cleaned) return
    if (!apiKey) {
      onError?.('请设置 API Key / Set API Key')
      return
    }

    // Create new session (auto-cancels prior)
    const session = sessionManager.create({ direction: 'zh→id', inputMode: 'text' })

    dispatch({ type: 'START', session, inputMode: 'text', sessionId: session.id })
    startMetrics(session, { input: 'text', model_stt: null })

    // Translate
    const { attemptId: translateAttemptId, signal: tlSignal } = session.newTranslateAttempt()
    const sourceLangName = getLangName(SOURCE_LANG.code)
    const targetLangName = getLangName(targetLangCode)

    let translation
    try {
      translation = await translateRouted(session, cleaned, sourceLangName, targetLangName, tlSignal)
    } catch (err) {
      if (tlSignal.aborted || session.cancelled) return
      session.recordError({ code: 'translate-failed', msg: err?.message })
      logTurn(session, 'translate-failed', err)
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: translateAttemptId,
        code: 'translate-failed',
        message: err?.message || 'translation failed'
      })
      onError?.('翻译出错：' + userMessage(err))
      return
    }
    if (!translation || !sessionManager.isCurrent(session)) return

    // Chunk + dispatch TRANSLATION_READY
    const chunks = splitChunks(translation)
    dispatch({
      type: 'TRANSLATION_READY',
      sessionId: session.id,
      translateAttemptId,
      text: translation,
      chunkCount: chunks.length
    })

    // Notify host about completed translation (for message history)
    onTranslationDone?.({
      originalText: cleaned,
      translatedText: translation,
      direction: session.direction,
      fromLang: 'zh',
      toLang: targetLangCode
    })

    // Play
    await playChunks(session, chunks)
  }, [apiKey, targetLangCode, voice, translateRouted, onTranslationDone, onError])

  // ====================================================================
  // VOICE mode — right side (target lang → Chinese) via MediaRecorder
  // ====================================================================
  const startVoice = useCallback(async (side) => {
    if (!apiKey) {
      onError?.('请设置 API Key / Set API Key')
      return
    }
    const direction = side === 'left' ? 'zh→id' : 'id→zh'
    const session = sessionManager.create({ direction, inputMode: 'voice' })

    dispatch({ type: 'START', session, side, inputMode: 'voice', sessionId: session.id })
    startMetrics(session, { input: 'voice', model_stt: sttModel })

    // Acquire mic
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      session.recordError({ code: 'mic-permission', msg: err?.message })
      dispatch({ type: 'ERROR', sessionId: session.id, code: 'mic-permission', message: err?.message })
      onError?.('麦克风权限被拒绝')
      return
    }
    if (session.cancelled) {
      stream.getTracks().forEach(t => t.stop())
      return
    }

    // Pick supported MIME type
    const mimeType = MIME_CANDIDATES.find(m => {
      try { return MediaRecorder.isTypeSupported(m) } catch { return false }
    }) || ''

    let recorder
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    } catch (err) {
      stream.getTracks().forEach(t => t.stop())
      session.recordError({ code: 'recorder-init', msg: err?.message })
      dispatch({ type: 'ERROR', sessionId: session.id, code: 'recorder-init', message: err?.message })
      onError?.('录音器初始化失败')
      return
    }

    const chunks = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    recorder.onerror = (e) => {
      session.recordError({ code: 'recorder-error', msg: String(e?.error || e) })
    }

    // Attach to session for cleanup
    session.resources.mediaStream = stream
    session.resources.mediaRecorder = recorder
    recorderStateRef.current = { recorder, chunks, mimeType, stream }

    try {
      recorder.start()
    } catch (err) {
      session.recordError({ code: 'recorder-start', msg: err?.message })
      dispatch({ type: 'ERROR', sessionId: session.id, code: 'recorder-start', message: err?.message })
      onError?.('录音启动失败')
      session.cancel('start-failed')
      return
    }
  }, [apiKey, sttModel, onError])

  // ====================================================================
  // Stop voice — process recorded audio
  // ====================================================================
  const stopVoice = useCallback(async () => {
    const session = state.session || stateRef.current.session
    if (!session) return
    if (stateRef.current.status !== STATES.RECORDING) return

    const rs = recorderStateRef.current
    if (!rs.recorder) return

    // Stop recording and await final dataavailable
    await new Promise(resolve => {
      rs.recorder.onstop = () => resolve()
      try {
        if (rs.recorder.state !== 'inactive') rs.recorder.stop()
        else resolve()
      } catch {
        resolve()
      }
    })

    // Stop tracks
    if (rs.stream) {
      try { rs.stream.getTracks().forEach(t => t.stop()) } catch {}
    }

    if (session.cancelled) return

    const audioBlob = new Blob(rs.chunks, { type: rs.mimeType || 'audio/webm' })

    // No audio → idle
    if (audioBlob.size < 1000) {
      dispatch({ type: 'STOP', sessionId: session.id, nextPhase: null })
      dispatch({ type: 'EMPTY_INPUT', sessionId: session.id })
      sessionManager.dispose(session)
      return
    }

    dispatch({ type: 'STOP', sessionId: session.id, nextPhase: 'transcribing' })

    // Transcribe
    const { attemptId: trAttemptId, signal: trSignal } = session.newTranscribeAttempt()
    const sttLang = session.direction === 'zh→id' ? 'zh' : isoFromTargetLangCode(targetLangCode)
    let transcript
    try {
      transcript = await transcribeAudio(
        audioBlob,
        rs.mimeType,
        sttLang,
        sttPrompt,
        apiKey,
        trSignal,
        sttModel
      )
    } catch (err) {
      if (trSignal.aborted || session.cancelled) return
      session.recordError({ code: 'transcribe-failed', msg: err?.message })
      logTurn(session, 'transcribe-failed', err)
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: trAttemptId,
        code: 'transcribe-failed',
        message: err?.message
      })
      onError?.('语音识别失败：' + userMessage(err))
      return
    }
    if (!sessionManager.isCurrent(session)) return
    if (!transcript || !transcript.trim()) {
      dispatch({ type: 'EMPTY_INPUT', sessionId: session.id })
      sessionManager.dispose(session)
      return
    }

    dispatch({
      type: 'TRANSCRIPT_READY',
      sessionId: session.id,
      transcribeAttemptId: trAttemptId,
      text: transcript
    })

    // Translate
    const { attemptId: tlAttemptId, signal: tlSignal } = session.newTranslateAttempt()
    const targetLangName = session.direction === 'zh→id'
      ? getLangName(targetLangCode)
      : getLangName(SOURCE_LANG.code)
    const sourceLangName = session.direction === 'zh→id'
      ? getLangName(SOURCE_LANG.code)
      : getLangName(targetLangCode)
    const fromLang = session.direction === 'zh→id' ? 'zh' : targetLangCode
    const toLang = session.direction === 'zh→id' ? targetLangCode : 'zh'

    let translation
    try {
      translation = await translateRouted(session, transcript, sourceLangName, targetLangName, tlSignal)
    } catch (err) {
      if (tlSignal.aborted || session.cancelled) return
      session.recordError({ code: 'translate-failed', msg: err?.message })
      logTurn(session, 'translate-failed', err)
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: tlAttemptId,
        code: 'translate-failed',
        message: err?.message
      })
      onError?.('翻译出错：' + userMessage(err))
      return
    }
    if (!translation || !sessionManager.isCurrent(session)) return

    const chunks = splitChunks(translation)
    dispatch({
      type: 'TRANSLATION_READY',
      sessionId: session.id,
      translateAttemptId: tlAttemptId,
      text: translation,
      chunkCount: chunks.length
    })

    onTranslationDone?.({
      originalText: transcript,
      translatedText: translation,
      direction: session.direction,
      fromLang,
      toLang
    })

    await playChunks(session, chunks)
  }, [state.session, apiKey, targetLangCode, sttPrompt, sttModel, voice, translateRouted, onTranslationDone, onError])

  // ====================================================================
  // Cancel voice — abort current recording without processing
  // ====================================================================
  const cancelVoice = useCallback(() => {
    const session = stateRef.current.session
    if (session) session.cancel('user-cancel')
    const rs = recorderStateRef.current
    if (rs.recorder && rs.recorder.state !== 'inactive') {
      try { rs.recorder.ondataavailable = null } catch {}
      try { rs.recorder.stop() } catch {}
    }
    if (rs.stream) {
      try { rs.stream.getTracks().forEach(t => t.stop()) } catch {}
    }
    recorderStateRef.current = { recorder: null, chunks: [], mimeType: null, stream: null }
    dispatch({ type: 'RESET', reason: 'cancel' })
  }, [])

  // ====================================================================
  // REPLAY — re-speak an existing translation (skip translate stage)
  // See DEC-2026-09-04-message-replay-audio
  // ====================================================================
  const replay = useCallback(async (text, direction = 'zh→id') => {
    const cleaned = (text || '').trim()
    if (!cleaned) return
    if (!apiKey) {
      onError?.('请设置 API Key / Set API Key')
      return
    }
    // If currently recording, ignore — user must finish/cancel that first
    if (stateRef.current.status === STATES.RECORDING ||
        stateRef.current.status === STATES.TRANSCRIBING) {
      return
    }

    // sessionManager.create auto-cancels current session (interrupts current playback)
    const session = sessionManager.create({ direction, inputMode: 'text' })
    dispatch({ type: 'START', session, inputMode: 'text', sessionId: session.id })
    startMetrics(session, { input: 'replay', model_stt: null })

    // We already have the translated text — synthesize a translate attempt just
    // for the reducer's stale-rejection contract, then jump to speaking.
    const { attemptId: translateAttemptId } = session.newTranslateAttempt()
    const chunks = splitChunks(cleaned)

    dispatch({
      type: 'TRANSLATION_READY',
      sessionId: session.id,
      translateAttemptId,
      text: cleaned,
      chunkCount: chunks.length
    })

    await playChunks(session, chunks)
  }, [apiKey, voice, onError])
  // NOTE: playChunks is stable-ish via its own useCallback; not a dep here to
  // avoid re-creating replay on every audio setting change.

  // ====================================================================
  // playChunks — drive audioEngine and dispatch its events
  // ====================================================================
  const playChunks = useCallback(async (session, chunks) => {
    const provider = new OpenAIStandardTTS({ apiKey })
    session.metrics.tts_provider = provider.name
    session.metrics.tts_chunks = chunks.length
    session.metrics.tts_failed_chunks = 0

    await audioEngine.play(
      session,
      chunks,
      voice,
      provider,
      (eventType, payload) => {
        // Forward audio events to FSM
        dispatch({ type: eventType, ...payload })
        if (eventType === 'CHUNK_FAILED') {
          session.metrics.tts_failed_chunks += 1
        }
        if (eventType === 'SPEAK_DONE') {
          logTurn(session, session.metrics.tts_failed_chunks ? 'ok-with-tts-failures' : 'ok')
          sessionManager.dispose(session)
        }
      }
    )
  }, [apiKey, voice])

  return {
    state,
    sendText,
    startVoice,
    stopVoice,
    cancelVoice,
    replay,
    resetModelRouting,
    forceReset
  }
}

// ---- Per-turn observability (PRD-002 §6) ----------------------------

function startMetrics(session, { input, model_stt }) {
  session.metrics = {
    t0: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    input,
    direction: session.direction,
    model_stt,
    model_translation: null,
    fallback_triggered: false
  }
}

// One structured line per turn: open DevTools → Console → filter "translator_turn".
function logTurn(session, outcome, err) {
  const m = session.metrics || {}
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  console.info('translator_turn', {
    sessionId: session.id,
    outcome,
    input: m.input,
    direction: m.direction,
    model_stt: m.model_stt,
    model_translation: m.model_translation,
    fallback_triggered: m.fallback_triggered,
    tts_provider: m.tts_provider || null,
    tts_chunks: m.tts_chunks ?? null,
    tts_failed_chunks: m.tts_failed_chunks ?? null,
    latency_ms: m.t0 != null ? Math.round(now - m.t0) : null,
    error: err ? { status: err.status ?? null, code: err.code ?? null, message: err.message } : null
  })
}

// Short, actionable error text for the banner.
function userMessage(err) {
  switch (classifyError(err)) {
    case 'auth': return 'API Key 无效或没有权限，请在设置里检查'
    case 'network': return '网络连接失败，请检查网络后重试'
    case 'transient': return 'OpenAI 服务暂时不稳定，请稍后重试'
    default: return err?.message || '未知错误'
  }
}

// Map BCP-47 language code to ISO 639-1 for Whisper `language` parameter
function isoFromTargetLangCode(code) {
  if (!code) return ''
  const map = {
    'zh-CN': 'zh',
    'id-ID': 'id',
    'en-US': 'en',
    'vi-VN': 'vi',
    'th-TH': 'th',
    'es-ES': 'es',
    'ru-RU': 'ru',
    'ar-SA': 'ar'
  }
  return map[code] || code.split('-')[0] || ''
}
