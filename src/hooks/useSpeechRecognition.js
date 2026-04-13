import { useRef, useCallback, useEffect } from 'react'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
const isAndroid = /Android/i.test(navigator.userAgent)

function dlog(msg) {
  if (window.__debugLog) window.__debugLog('STT', msg)
}

// Log detection info once on load
dlog(`SpeechRecognition available: ${!!SpeechRecognition}`)
dlog(`isMobile: ${isMobile}, isAndroid: ${isAndroid}`)
dlog(`UA: ${navigator.userAgent.substring(0, 80)}`)

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
        dlog('Requesting mic permission...')
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(t => t.stop())
        dlog('OK Mic permission granted')
      } catch (e) {
        dlog(`WARN Mic permission failed: ${e.message}`)
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
      dlog('ERROR SpeechRecognition not supported')
      onError?.('not-supported')
      return null
    }

    dlog(`Creating recognition: lang=${lang}, continuous=${!isMobile}`)
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

      dlog(`Result: interim="${interim.substring(0,30)}" final="${final.substring(0,30)}"`)

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
            dlog(`Delivering final text: "${finalTextRef.current.substring(0,40)}"`)
            onFinal?.(finalTextRef.current)
            finalTextRef.current = ''
            interimTextRef.current = ''
          }
        }, 500)
      }
    }

    recognition.onerror = (event) => {
      dlog(`ERROR recognition.onerror: ${event.error} (message: ${event.message || 'none'})`)
      if (event.error === 'no-speech' || event.error === 'aborted') return
      onError?.(event.error)
    }

    recognition.onstart = () => {
      dlog('OK recognition.onstart fired — listening active')
    }

    recognition.onspeechstart = () => {
      dlog('OK Speech detected (onspeechstart)')
    }

    recognition.onspeechend = () => {
      dlog('Speech ended (onspeechend)')
    }

    recognition.onaudiostart = () => {
      dlog('OK Audio capture started (onaudiostart)')
    }

    recognition.onaudioend = () => {
      dlog('Audio capture ended (onaudioend)')
    }

    recognition.onnomatch = () => {
      dlog('WARN No match (onnomatch)')
    }

    recognition.onend = () => {
      dlog(`recognition.onend — isListening: ${isListeningRef.current}`)
      if (isListeningRef.current) {
        // Deliver accumulated text on mobile when recognition auto-stops
        if (isMobile && (finalTextRef.current || interimTextRef.current)) {
          const text = finalTextRef.current || interimTextRef.current
          dlog(`Mobile auto-stop, delivering: "${text.substring(0,30)}"`)
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
        const restartDelay = isMobile ? 200 : 100
        dlog(`Auto-restart in ${restartDelay}ms`)
        setTimeout(() => {
          if (isListeningRef.current && recognitionRef.current) {
            try {
              recognitionRef.current.start()
              dlog('OK Auto-restart succeeded')
            } catch (e) {
              dlog(`ERROR Auto-restart failed: ${e.message}`)
            }
          }
        }, restartDelay)
      }
    }

    return recognition
  }, [onInterim, onFinal, onError])

  // MUST be synchronous — called directly from user gesture (pointerdown)
  const start = useCallback((lang = 'zh-CN') => {
    dlog(`start() called: lang=${lang}`)

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
      dlog('OK recognition.start() called successfully')
    } catch (e) {
      dlog(`ERROR recognition.start() failed: ${e.message}`)
      onError?.(e.message)
    }
  }, [createRecognition, onError])

  const stop = useCallback(() => {
    dlog('stop() called')
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
