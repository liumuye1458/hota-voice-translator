import { useRef, useCallback, useEffect } from 'react'
import { emitRecEvent } from '../components/RecognitionStatus'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

// Request microphone permission explicitly (needed on some Android devices)
async function ensureMicPermission() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    // Got permission, release the stream immediately
    stream.getTracks().forEach(t => t.stop())
    return true
  } catch (e) {
    console.error('Mic permission denied:', e)
    return false
  }
}

export function useSpeechRecognition({ onInterim, onFinal, onError }) {
  const recognitionRef = useRef(null)
  const isListeningRef = useRef(false)
  const debounceRef = useRef(null)
  const finalTextRef = useRef('')
  const interimTextRef = useRef('')
  const micPermissionRef = useRef(false)

  const createRecognition = useCallback((lang) => {
    if (!SpeechRecognition) {
      onError?.('not-supported')
      return null
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = !isMobile
    recognition.interimResults = true
    recognition.lang = lang
    recognition.maxAlternatives = 1

    recognition.onstart = () => emitRecEvent('onstart', lang)
    recognition.onaudiostart = () => emitRecEvent('audiostart', '')
    recognition.onspeechstart = () => emitRecEvent('speechstart', '')
    recognition.onspeechend = () => emitRecEvent('speechend', '')
    recognition.onaudioend = () => emitRecEvent('audioend', '')
    recognition.onnomatch = () => emitRecEvent('nomatch', '')

    recognition.onresult = (event) => {
      let interim = ''
      let final = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          final += transcript
        } else {
          interim += transcript
        }
      }

      if (interim) {
        interimTextRef.current = interim
        onInterim?.(interim)
        emitRecEvent('interim', interim.substring(0, 20))
      }

      if (final) {
        finalTextRef.current += final
        emitRecEvent('final', final.substring(0, 20))
        onInterim?.(finalTextRef.current)

        clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          if (isListeningRef.current) {
            onFinal?.(finalTextRef.current)
            finalTextRef.current = ''
            interimTextRef.current = ''
          }
        }, 500)
      }
    }

    recognition.onerror = (event) => {
      console.warn('SpeechRecognition error:', event.error)
      emitRecEvent('ERROR', event.error)
      if (event.error === 'no-speech' || event.error === 'aborted') return
      if (event.error === 'not-allowed') {
        micPermissionRef.current = false
      }
      onError?.(event.error)
    }

    recognition.onend = () => {
      emitRecEvent('onend', isListeningRef.current ? 'still listening' : 'stopped')
      if (isListeningRef.current) {
        // Deliver accumulated text on mobile
        if (isMobile && (finalTextRef.current || interimTextRef.current)) {
          const text = finalTextRef.current || interimTextRef.current
          clearTimeout(debounceRef.current)
          debounceRef.current = setTimeout(() => {
            if (isListeningRef.current) {
              onFinal?.(text)
              finalTextRef.current = ''
              interimTextRef.current = ''
            }
          }, 300)
        }
        // Auto-restart
        try {
          setTimeout(() => {
            if (isListeningRef.current && recognitionRef.current) {
              recognitionRef.current.start()
            }
          }, isMobile ? 200 : 100)
        } catch (e) {
          // ignore
        }
      }
    }

    return recognition
  }, [onInterim, onFinal, onError])

  const start = useCallback(async (lang = 'zh-CN') => {
    emitRecEvent('start()', lang)
    stop()

    // On mobile, ensure mic permission first
    if (!micPermissionRef.current) {
      const granted = await ensureMicPermission()
      if (!granted) {
        onError?.('not-allowed')
        return
      }
      micPermissionRef.current = true
    }

    const recognition = createRecognition(lang)
    if (!recognition) return

    recognitionRef.current = recognition
    isListeningRef.current = true
    finalTextRef.current = ''
    interimTextRef.current = ''

    try {
      recognition.start()
      emitRecEvent('rec.start()', 'called')
    } catch (e) {
      console.error('recognition.start() failed:', e)
      emitRecEvent('ERROR start()', e.message)
      onError?.(e.message)
    }
  }, [createRecognition, onError])

  const stop = useCallback(() => {
    isListeningRef.current = false
    clearTimeout(debounceRef.current)
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (e) {
        // Ignore
      }
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => { stop() }
  }, [stop])

  return { start, stop, isSupported: !!SpeechRecognition }
}
