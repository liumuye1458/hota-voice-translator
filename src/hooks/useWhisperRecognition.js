import { useRef, useCallback, useEffect } from 'react'
import { transcribeAudio } from '../services/openai'

function dlog(msg) {
  if (window.__debugLog) window.__debugLog('WHSP', msg)
}

/**
 * Whisper-based speech recognition fallback for Android.
 * Uses MediaRecorder to capture audio, then sends to OpenAI Whisper API.
 * No interim text — shows "录音中..." while recording.
 */
export function useWhisperRecognition({ onInterim, onFinal, onError, apiKey }) {
  const mediaRecorderRef = useRef(null)
  const streamRef = useRef(null)
  const chunksRef = useRef([])
  const isListeningRef = useRef(false)
  const langRef = useRef('zh')

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
      }
    }
  }, [])

  const start = useCallback(async (lang = 'zh-CN') => {
    dlog(`start(${lang})`)

    // Map BCP-47 to ISO 639-1 for Whisper
    const langMap = {
      'zh-CN': 'zh', 'zh': 'zh',
      'id-ID': 'id', 'id': 'id',
      'en-US': 'en', 'en': 'en',
      'vi-VN': 'vi', 'vi': 'vi',
      'th-TH': 'th', 'th': 'th',
      'es-ES': 'es', 'es': 'es',
      'ru-RU': 'ru', 'ru': 'ru',
      'ar-SA': 'ar', 'ar': 'ar'
    }
    langRef.current = langMap[lang] || lang.split('-')[0] || 'zh'

    // Stop any existing recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop() } catch (e) {}
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
    }

    try {
      dlog('Requesting mic...')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      dlog('OK Mic acquired')

      // Choose a supported MIME type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : ''

      dlog(`MIME: ${mimeType || 'default'}`)

      const options = mimeType ? { mimeType } : {}
      const recorder = new MediaRecorder(stream, options)
      mediaRecorderRef.current = recorder
      chunksRef.current = []
      isListeningRef.current = true

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data)
          dlog(`Chunk: ${e.data.size} bytes`)
        }
      }

      recorder.onstart = () => {
        dlog('OK Recording started')
        // Show recording indicator as "interim text"
        onInterim?.('🔴 录音中... Recording...')
      }

      recorder.onerror = (e) => {
        dlog(`ERROR Recorder: ${e.error?.name || e.message || 'unknown'}`)
        onError?.(e.error?.name || 'recording-error')
      }

      recorder.onstop = async () => {
        dlog(`Recording stopped, ${chunksRef.current.length} chunks`)
        isListeningRef.current = false

        // Stop mic
        stream.getTracks().forEach(t => t.stop())
        streamRef.current = null

        if (chunksRef.current.length === 0) {
          dlog('WARN No audio data')
          onInterim?.('')
          return
        }

        const blob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm'
        })
        dlog(`Audio blob: ${blob.size} bytes, type: ${blob.type}`)

        if (blob.size < 1000) {
          dlog('WARN Audio too short')
          onInterim?.('')
          return
        }

        // Show transcribing status
        onInterim?.('⏳ 识别中... Transcribing...')

        try {
          dlog(`Sending to Whisper API, lang=${langRef.current}`)
          const text = await transcribeAudio(blob, langRef.current, apiKey)
          dlog(`OK Whisper result: "${text.substring(0, 40)}"`)
          onInterim?.('')
          if (text) {
            onFinal?.(text)
          }
        } catch (err) {
          dlog(`ERROR Whisper: ${err.message}`)
          onInterim?.('')
          onError?.(err.message)
        }
      }

      // Start recording, collect data every 500ms
      recorder.start(500)
    } catch (err) {
      dlog(`ERROR getUserMedia: ${err.message}`)
      onError?.(err.message)
    }
  }, [onInterim, onFinal, onError, apiKey])

  const stop = useCallback(() => {
    dlog('stop()')
    isListeningRef.current = false
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop() } catch (e) {}
    }
    // Don't stop stream here — onstop handler will do it
  }, [])

  return { start, stop, isSupported: !!(navigator.mediaDevices?.getUserMedia) }
}
