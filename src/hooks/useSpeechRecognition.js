import { useRef, useCallback, useEffect } from 'react'

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
const isAndroid = /Android/i.test(navigator.userAgent)

function dlog(msg) {
  if (window.__debugLog) window.__debugLog('STT', msg)
}

dlog(`SpeechRecognition: ${!!SpeechRecognition}, mobile: ${isMobile}, android: ${isAndroid}`)

export function useSpeechRecognition({ onInterim, onFinal, onError }) {
  const recognitionRef = useRef(null)
  const isListeningRef = useRef(false)
  const debounceRef = useRef(null)
  const finalTextRef = useRef('')
  const interimTextRef = useRef('')
  // Guard: each start() gets a unique session ID; stale sessions are ignored
  const sessionIdRef = useRef(0)

  // Request mic permission on first user interaction
  useEffect(() => {
    const requestMic = async () => {
      try {
        dlog('Requesting mic permission...')
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach(t => t.stop())
        dlog('OK Mic permission granted')
      } catch (e) {
        dlog(`WARN Mic permission: ${e.message}`)
      }
    }
    const handler = () => {
      requestMic()
      window.removeEventListener('pointerdown', handler)
    }
    window.addEventListener('pointerdown', handler, { once: true })
    return () => window.removeEventListener('pointerdown', handler)
  }, [])

  const createRecognition = useCallback((lang, sessionId) => {
    if (!SpeechRecognition) {
      dlog('ERROR SpeechRecognition not supported')
      onError?.('not-supported')
      return null
    }

    // Android: never use continuous mode, it causes immediate abort
    const useContinuous = !isMobile
    dlog(`Creating recognition: lang=${lang}, continuous=${useContinuous}, session=${sessionId}`)

    const recognition = new SpeechRecognition()
    recognition.continuous = useContinuous
    recognition.interimResults = true
    recognition.lang = lang
    recognition.maxAlternatives = 1

    recognition.onresult = (event) => {
      // Ignore results from stale sessions
      if (sessionIdRef.current !== sessionId) return

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
          if (isListeningRef.current && sessionIdRef.current === sessionId) {
            dlog(`Delivering final: "${finalTextRef.current.substring(0,40)}"`)
            onFinal?.(finalTextRef.current)
            finalTextRef.current = ''
            interimTextRef.current = ''
          }
        }, 500)
      }
    }

    recognition.onerror = (event) => {
      if (sessionIdRef.current !== sessionId) return
      dlog(`ERROR onerror: ${event.error}`)
      if (event.error === 'no-speech') return
      // On Android, 'aborted' means the instance was killed — don't propagate
      if (event.error === 'aborted') return
      onError?.(event.error)
    }

    recognition.onstart = () => {
      if (sessionIdRef.current !== sessionId) return
      dlog('OK onstart — listening active')
    }

    recognition.onspeechstart = () => {
      dlog('OK Speech detected')
    }

    recognition.onaudiostart = () => {
      dlog('OK Audio capture started')
    }

    recognition.onend = () => {
      // CRITICAL: ignore onend from stale/old sessions
      if (sessionIdRef.current !== sessionId) {
        dlog(`onend IGNORED (stale session ${sessionId}, current ${sessionIdRef.current})`)
        return
      }
      dlog(`onend — isListening: ${isListeningRef.current}`)

      if (!isListeningRef.current) return

      // Deliver accumulated text on mobile when recognition auto-stops
      if (isMobile && (finalTextRef.current || interimTextRef.current)) {
        const text = finalTextRef.current || interimTextRef.current
        dlog(`Mobile auto-deliver: "${text.substring(0,30)}"`)
        clearTimeout(debounceRef.current)
        debounceRef.current = setTimeout(() => {
          if (isListeningRef.current && sessionIdRef.current === sessionId) {
            onFinal?.(text)
            finalTextRef.current = ''
            interimTextRef.current = ''
          }
        }, 300)
      }

      // Auto-restart if still listening
      const delay = isAndroid ? 300 : isMobile ? 200 : 100
      dlog(`Auto-restart in ${delay}ms`)
      setTimeout(() => {
        if (isListeningRef.current && sessionIdRef.current === sessionId) {
          try {
            recognition.start()
            dlog('OK Auto-restart succeeded')
          } catch (e) {
            dlog(`WARN Auto-restart failed: ${e.message}`)
          }
        }
      }, delay)
    }

    return recognition
  }, [onInterim, onFinal, onError])

  // MUST be synchronous — called directly from user gesture (pointerdown)
  const start = useCallback((lang = 'zh-CN') => {
    dlog(`--- start(${lang}) ---`)

    // Bump session ID to invalidate any old recognition's callbacks
    const newSession = ++sessionIdRef.current

    // Kill old instance completely — its onend will be ignored due to stale sessionId
    clearTimeout(debounceRef.current)
    if (recognitionRef.current) {
      try { recognitionRef.current.abort() } catch (e) {}
      recognitionRef.current = null
    }

    // Set state before creating recognition
    isListeningRef.current = true
    finalTextRef.current = ''
    interimTextRef.current = ''

    // On Android, add a small delay after abort to avoid conflict
    if (isAndroid) {
      dlog('Android: delayed start (150ms)')
      setTimeout(() => {
        if (sessionIdRef.current !== newSession) return
        const recognition = createRecognition(lang, newSession)
        if (!recognition) return
        recognitionRef.current = recognition
        try {
          recognition.start()
          dlog('OK recognition.start() called (Android delayed)')
        } catch (e) {
          dlog(`ERROR start() failed: ${e.message}`)
          onError?.(e.message)
        }
      }, 150)
    } else {
      const recognition = createRecognition(lang, newSession)
      if (!recognition) return
      recognitionRef.current = recognition
      try {
        recognition.start()
        dlog('OK recognition.start() called')
      } catch (e) {
        dlog(`ERROR start() failed: ${e.message}`)
        onError?.(e.message)
      }
    }
  }, [createRecognition, onError])

  const stop = useCallback(() => {
    dlog('stop()')
    isListeningRef.current = false
    clearTimeout(debounceRef.current)
    // Bump session to invalidate callbacks
    sessionIdRef.current++
    if (recognitionRef.current) {
      try { recognitionRef.current.abort() } catch (e) {}
      recognitionRef.current = null
    }
  }, [])

  useEffect(() => {
    return () => { stop() }
  }, [stop])

  return { start, stop, isSupported: !!SpeechRecognition }
}
