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
import { translateText, synthesizeSpeech, transcribeAudio } from '../services/openai.js'

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
    onTranslationDone,
    onError
  } = opts

  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  useEffect(() => { stateRef.current = state }, [state])

  // Stable refs to latest values for use inside async callbacks
  const optsRef = useRef(opts)
  useEffect(() => { optsRef.current = opts }, [opts])

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

    // Translate
    const { attemptId: translateAttemptId, signal: tlSignal } = session.newTranslateAttempt()
    const sourceLangName = getLangName(SOURCE_LANG.code)
    const targetLangName = getLangName(targetLangCode)

    let translation
    try {
      translation = await translateText(
        cleaned,
        sourceLangName,
        targetLangName,
        apiKey,
        customInstructions,
        tlSignal
      )
    } catch (err) {
      if (tlSignal.aborted || session.cancelled) return
      session.recordError({ code: 'translate-failed', msg: err?.message })
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: translateAttemptId,
        code: 'translate-failed',
        message: err?.message || 'translation failed'
      })
      onError?.(err?.message || '翻译出错')
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
  }, [apiKey, customInstructions, targetLangCode, voice, onTranslationDone, onError])

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
  }, [apiKey, onError])

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
        trSignal
      )
    } catch (err) {
      if (trSignal.aborted || session.cancelled) return
      session.recordError({ code: 'transcribe-failed', msg: err?.message })
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: trAttemptId,
        code: 'transcribe-failed',
        message: err?.message
      })
      onError?.('语音识别失败: ' + (err?.message || ''))
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
      translation = await translateText(
        transcript,
        sourceLangName,
        targetLangName,
        apiKey,
        customInstructions,
        tlSignal
      )
    } catch (err) {
      if (tlSignal.aborted || session.cancelled) return
      session.recordError({ code: 'translate-failed', msg: err?.message })
      dispatch({
        type: 'ERROR',
        sessionId: session.id,
        attemptId: tlAttemptId,
        code: 'translate-failed',
        message: err?.message
      })
      onError?.('翻译失败: ' + (err?.message || ''))
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
  }, [state.session, apiKey, customInstructions, targetLangCode, sttPrompt, voice, onTranslationDone, onError])

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
    const ttsBound = (text, v, signal) => synthesizeSpeech(text, v, apiKey, signal)

    await audioEngine.play(
      session,
      chunks,
      voice,
      ttsBound,
      (eventType, payload) => {
        // Forward audio events to FSM
        dispatch({ type: eventType, ...payload })
        // After SPEAK_DONE, dispose session
        if (eventType === 'SPEAK_DONE') {
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
    forceReset
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
