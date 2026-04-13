import { useRef, useCallback, useEffect } from 'react'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition

export function useSpeechRecognition({ onInterim, onFinal, onError }) {
  const recognitionRef = useRef(null)
  const isListeningRef = useRef(false)
  const debounceRef = useRef(null)
  const finalTextRef = useRef('')

  const createRecognition = useCallback((lang) => {
    if (!SpeechRecognition) {
      onError?.('SpeechRecognition not supported in this browser')
      return null
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = lang
    recognition.maxAlternatives = 1

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
        onInterim?.(interim)
      }

      if (final) {
        finalTextRef.current = final
        onInterim?.(final)

        // Debounce: wait 500ms after final result before triggering
        clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          if (isListeningRef.current) {
            onFinal?.(finalTextRef.current)
            finalTextRef.current = ''
          }
        }, 500)
      }
    }

    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') return
      onError?.(event.error)
    }

    recognition.onend = () => {
      // Auto-restart if we didn't intentionally stop
      if (isListeningRef.current) {
        try {
          recognition.start()
        } catch (e) {
          // Already started, ignore
        }
      }
    }

    return recognition
  }, [onInterim, onFinal, onError])

  const start = useCallback((lang = 'zh-CN') => {
    stop()
    const recognition = createRecognition(lang)
    if (!recognition) return

    recognitionRef.current = recognition
    isListeningRef.current = true
    finalTextRef.current = ''

    try {
      recognition.start()
    } catch (e) {
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
    return () => {
      stop()
    }
  }, [stop])

  return { start, stop, isSupported: !!SpeechRecognition }
}
