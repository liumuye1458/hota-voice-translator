import { useRef, useCallback, useEffect } from 'react'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

export function useSpeechRecognition({ onInterim, onFinal, onError }) {
  const recognitionRef = useRef(null)
  const isListeningRef = useRef(false)
  const debounceRef = useRef(null)
  const finalTextRef = useRef('')
  const interimTextRef = useRef('')

  // Request mic permission on first user interaction (async, non-blocking)
  useEffect(() => {
    const requestMic = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(t => t.stop())
      } catch (e) {
        // Will be handled when recognition starts
      }
    }
    const handler = () => {
      requestMic()
      window.removeEventListener('pointerdown', handler)
    }
    window.addEventListener('pointerdown', handler, { once: true })
    return () => window.removeEventListener('pointerdown', handler)
  }, [])

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
      }

      if (final) {
        finalTextRef.current += final
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
      if (event.error === 'no-speech' || event.error === 'aborted') return
      onError?.(event.error)
    }

    recognition.onend = () => {
      if (isListeningRef.current) {
        // Deliver accumulated text on mobile when recognition auto-stops
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
        // Auto-restart if still listening
        setTimeout(() => {
          if (isListeningRef.current && recognitionRef.current) {
            try {
              recognitionRef.current.start()
            } catch (e) {
              // ignore
            }
          }
        }, isMobile ? 200 : 100)
      }
    }

    return recognition
  }, [onInterim, onFinal, onError])

  // MUST be synchronous — called directly from user gesture (pointerdown)
  const start = useCallback((lang = 'zh-CN') => {
    // Stop any existing
    isListeningRef.current = false
    clearTimeout(debounceRef.current)
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch (e) {}
      recognitionRef.current = null
    }

    const recognition = createRecognition(lang)
    if (!recognition) return

    recognitionRef.current = recognition
    isListeningRef.current = true
    finalTextRef.current = ''
    interimTextRef.current = ''

    try {
      recognition.start()
    } catch (e) {
      console.error('recognition.start() failed:', e)
      onError?.(e.message)
    }
  }, [createRecognition, onError])

  const stop = useCallback(() => {
    isListeningRef.current = false
    clearTimeout(debounceRef.current)
    if (recognitionRef.current) {
      try { recognitionRef.current.stop() } catch (e) {}
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => { stop() }
  }, [stop])

  return { start, stop, isSupported: !!SpeechRecognition }
}
