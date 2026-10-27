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
import { detectTextDirection } from '../core/textDirection.js'
import { ChunkFeed } from '../core/chunkFeed.js'
import {
  RealtimeTranscriber,
  SecretCache,
  createWorkletCapture,
  transcriptionSessionConfig,
  warmCapture
} from '../core/realtimeStt.js'
import { translateText, translateTextStream, transcribeAudio, mintRealtimeClientSecret } from '../services/openai.js'
import { OpenAIStandardTTS } from '../core/ttsProvider.js'
import { buildSttPrompt } from '../config/domainPrompt.js'
import {
  TranslationModelRouter,
  runWithModelRouting,
  classifyError,
  DEFAULT_TRANSLATION_MODEL,
  DEFAULT_STT_MODEL,
  REALTIME_STT_MODEL,
  UPLOAD_STT_FALLBACK
} from '../core/modelRouter.js'

// Ephemeral Realtime secrets, shared by the whole page (ADR-005)
const secretCache = new SecretCache(mintRealtimeClientSecret)
const PREWARM_INTERVAL_MS = 5 * 60 * 1000

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

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
 *   sendText(text) — text-mode translation, direction auto-detected from content
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
  // With onChunk the translation streams (first sentence early, PRD-003 §3.1).
  const translateRouted = useCallback(async (session, text, sourceLangName, targetLangName, signal, onChunk) => {
    const { result, model } = await runWithModelRouting(
      routerRef.current,
      (m) => onChunk
        ? translateTextStream(text, sourceLangName, targetLangName, apiKey, customInstructions, signal, m, onChunk)
        : translateText(text, sourceLangName, targetLangName, apiKey, customInstructions, signal, m),
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

  // ====================================================================
  // playChunks — drive audioEngine and dispatch its events
  // ====================================================================
  const playChunks = useCallback(async (session, chunks) => {
    const provider = new OpenAIStandardTTS({ apiKey })
    session.metrics.tts_provider = provider.name
    session.metrics.tts_failed_chunks = 0

    await audioEngine.play(
      session,
      chunks,
      voice,
      provider,
      (eventType, payload) => {
        // Forward audio events to FSM
        dispatch({ type: eventType, ...payload })
        if (eventType === 'CHUNK_PLAYING' && session.metrics.t_first_audio == null) {
          session.metrics.t_first_audio = nowMs()
        }
        if (eventType === 'CHUNK_FAILED') {
          session.metrics.tts_failed_chunks += 1
        }
        if (eventType === 'SPEAK_DONE') {
          session.metrics.tts_chunks = Array.isArray(chunks) ? chunks.length : chunks.total
          logTurn(session, session.metrics.tts_failed_chunks ? 'ok-with-tts-failures' : 'ok')
          sessionManager.dispose(session)
        }
      }
    )
  }, [apiKey, voice])

  // ====================================================================
  // Translate (streaming) and speak as soon as the first sentence is ready.
  // Shared by voice and Chinese text input. PRD-003 §3.1.
  // ====================================================================
  const translateAndSpeak = useCallback(async (session, sourceText, { fromLang, toLang }) => {
    const { attemptId: translateAttemptId, signal } = session.newTranslateAttempt()
    const sourceLangName = getLangName(fromLang === 'zh' ? SOURCE_LANG.code : fromLang)
    const targetLangName = getLangName(toLang === 'zh' ? SOURCE_LANG.code : toLang)
    const tStart = nowMs()

    const feed = new ChunkFeed()
    let playing = null
    const onChunk = (text) => {
      if (!sessionManager.isCurrent(session)) return
      // Keep the TTS input-size guard (speech API max 4096 chars)
      for (const piece of splitChunks(text)) feed.push(piece)
      if (playing) return
      session.metrics.mt_first_ms = Math.round(nowMs() - tStart)
      dispatch({
        type: 'TRANSLATION_READY',
        sessionId: session.id,
        translateAttemptId,
        text,
        chunkCount: null
      })
      playing = playChunks(session, feed)
    }

    let translation
    try {
      translation = await translateRouted(session, sourceText, sourceLangName, targetLangName, signal, onChunk)
    } catch (err) {
      feed.end()
      if (signal.aborted || session.cancelled) return
      session.recordError({ code: 'translate-failed', msg: err?.message })
      onError?.('翻译出错：' + userMessage(err))
      if (playing) {
        // Part of the translation is already being spoken; let it finish.
        logTurn(session, 'translate-failed-partial', err)
        await playing
        return
      }
      logTurn(session, 'translate-failed', err)
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: translateAttemptId,
        code: 'translate-failed',
        message: err?.message || 'translation failed'
      })
      return
    }
    feed.end()
    if (!sessionManager.isCurrent(session)) return
    session.metrics.mt_ms = Math.round(nowMs() - tStart)

    if (!translation || !playing) {
      // Nothing to say (empty model output)
      dispatch({ type: 'EMPTY_INPUT', sessionId: session.id })
      logTurn(session, 'empty-translation')
      sessionManager.dispose(session)
      return
    }

    // Notify host about completed translation (for message history)
    onTranslationDone?.({
      originalText: sourceText,
      translatedText: translation,
      direction: session.direction,
      fromLang,
      toLang
    })

    await playing
  }, [translateRouted, playChunks, onTranslationDone, onError])

  // ====================================================================
  // Realtime STT config + prewarm (ADR-005)
  // ====================================================================
  const sttLangOf = useCallback((direction) => (
    direction === 'zh→id' ? 'zh' : isoFromTargetLangCode(targetLangCode)
  ), [targetLangCode])

  const realtimeConfigFor = useCallback((direction) => {
    const language = sttLangOf(direction)
    return transcriptionSessionConfig({
      model: REALTIME_STT_MODEL,
      language,
      prompt: buildSttPrompt(language, sttPrompt)
    })
  }, [sttLangOf, sttPrompt])

  // Keep a fresh secret for both buttons so a press doesn't wait for minting.
  // Debounced: the key / vocabulary fields change on every keystroke.
  useEffect(() => {
    if (!apiKey || sttModel !== 'realtime') return
    const warm = () => {
      secretCache.prewarm(apiKey, realtimeConfigFor('zh→id'))
      secretCache.prewarm(apiKey, realtimeConfigFor('id→zh'))
    }
    const first = setTimeout(warm, 1500)
    const t = setInterval(warm, PREWARM_INTERVAL_MS)
    return () => { clearTimeout(first); clearInterval(t) }
  }, [apiKey, sttModel, realtimeConfigFor])

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
  // TEXT mode — direction auto-detected from content
  // (DEC-2026-10-12-text-input-auto-direction)
  //   Chinese → target: translate + speak (unchanged)
  //   other   → Chinese: translate, show only (🔊 on the bubble to listen)
  // ====================================================================
  const sendText = useCallback(async (text) => {
    const cleaned = (text || '').trim()
    if (!cleaned) return
    if (!apiKey) {
      onError?.('请设置 API Key / Set API Key')
      return
    }

    const direction = detectTextDirection(cleaned)
    const toChinese = direction === 'id→zh'

    // Create new session (auto-cancels prior)
    const session = sessionManager.create({ direction, inputMode: 'text' })

    dispatch({ type: 'START', session, inputMode: 'text', sessionId: session.id })
    startMetrics(session, { input: 'text', model_stt: null })

    if (!toChinese) {
      await translateAndSpeak(session, cleaned, { fromLang: 'zh', toLang: targetLangCode })
      return
    }

    // Foreign text → Chinese: translate and show only (no speech)
    const { attemptId: translateAttemptId, signal: tlSignal } = session.newTranslateAttempt()
    const sourceLangName = getLangName(toChinese ? targetLangCode : SOURCE_LANG.code)
    const targetLangName = getLangName(toChinese ? SOURCE_LANG.code : targetLangCode)

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

    onTranslationDone?.({
      originalText: cleaned,
      translatedText: translation,
      direction,
      fromLang: targetLangCode,
      toLang: 'zh'
    })
    dispatch({ type: 'TEXT_DONE', sessionId: session.id, translateAttemptId })
    logTurn(session, 'ok-silent')
    sessionManager.dispose(session)
  }, [apiKey, targetLangCode, translateRouted, translateAndSpeak, onTranslationDone, onError])

  // ====================================================================
  // VOICE mode — right side (target lang → Chinese) via MediaRecorder
  // ====================================================================
  const startVoice = useCallback(async (side) => {
    if (!apiKey) {
      onError?.('请设置 API Key / Set API Key')
      return
    }
    // Still inside the press gesture: create/resume the capture AudioContext now
    if (sttModel === 'realtime') warmCapture()
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

    // Realtime STT alongside the recorder; the recording stays as fallback (ADR-005)
    if (sttModel === 'realtime') {
      const config = realtimeConfigFor(direction)
      const transcriber = new RealtimeTranscriber({
        getSecret: () => secretCache.get(apiKey, config),
        createCapture: createWorkletCapture
      })
      session.realtimeStt = transcriber
      session.addCleanup(() => transcriber.close())
      transcriber.start(stream)
    }
  }, [apiKey, sttModel, realtimeConfigFor, onError])

  // ====================================================================
  // Stop voice — process recorded audio
  // ====================================================================
  const stopVoice = useCallback(async () => {
    const session = state.session || stateRef.current.session
    if (!session) return
    if (stateRef.current.status !== STATES.RECORDING) return

    const rs = recorderStateRef.current
    if (!rs.recorder) return

    session.metrics.t_release = nowMs()
    // Realtime: stop capture + commit right away, in parallel with the recorder stop
    const realtime = session.realtimeStt ? session.realtimeStt.finish() : null

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

    // Transcribe: realtime result if it worked, else upload the recording (ADR-005)
    const { attemptId: trAttemptId, signal: trSignal } = session.newTranscribeAttempt()
    const sttLang = sttLangOf(session.direction)
    let transcript = null
    if (realtime) {
      const r = await realtime
      if (session.cancelled) return
      if (r.ok) {
        transcript = r.text
        session.metrics.stt_path = 'realtime'
        session.metrics.model_stt = REALTIME_STT_MODEL
      } else {
        session.metrics.stt_path = 'upload-fallback'
        session.metrics.fallback_reason = r.reason
        console.info('realtime_stt_fallback', { sessionId: session.id, reason: r.reason })
      }
      const tm = session.realtimeStt.timings
      if (tm.open != null) session.metrics.rt_connect_ms = Math.round(tm.open - tm.start)
    }
    try {
      if (transcript == null) {
        const uploadModel = sttModel === 'realtime' ? UPLOAD_STT_FALLBACK : sttModel
        session.metrics.stt_path ??= 'upload'
        session.metrics.model_stt = uploadModel
        transcript = await transcribeAudio(
          audioBlob,
          rs.mimeType,
          sttLang,
          buildSttPrompt(sttLang, sttPrompt),
          apiKey,
          trSignal,
          uploadModel
        )
      }
      session.metrics.stt_ms = Math.round(nowMs() - session.metrics.t_release)
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

    // Translate + speak (streaming)
    const fromLang = session.direction === 'zh→id' ? 'zh' : targetLangCode
    const toLang = session.direction === 'zh→id' ? targetLangCode : 'zh'
    await translateAndSpeak(session, transcript, { fromLang, toLang })
  }, [state.session, apiKey, targetLangCode, sttPrompt, sttModel, sttLangOf, translateAndSpeak, onError])

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
    t0: nowMs(),
    input,
    direction: session.direction,
    model_stt,
    model_translation: null,
    fallback_triggered: false
  }
}

// One structured line per turn: open DevTools → Console → filter "translator_turn".
// first_audio_ms = release (voice) or send (text) → first chunk starts playing (PRD-003 §3.4).
function logTurn(session, outcome, err) {
  const m = session.metrics || {}
  const now = nowMs()
  const origin = m.t_release ?? m.t0
  console.info('translator_turn', {
    sessionId: session.id,
    outcome,
    input: m.input,
    direction: m.direction,
    model_stt: m.model_stt,
    stt_path: m.stt_path || null,
    stt_ms: m.stt_ms ?? null,
    rt_connect_ms: m.rt_connect_ms ?? null,
    fallback_reason: m.fallback_reason || null,
    model_translation: m.model_translation,
    fallback_triggered: m.fallback_triggered,
    mt_first_ms: m.mt_first_ms ?? null,
    mt_ms: m.mt_ms ?? null,
    first_audio_ms: m.t_first_audio != null && origin != null ? Math.round(m.t_first_audio - origin) : null,
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
