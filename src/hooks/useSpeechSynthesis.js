import { useRef, useCallback } from 'react'
import { synthesizeSpeech } from '../services/openai'

export function useSpeechSynthesis({ onEnd, onError, apiKey, voice }) {
  const audioRef = useRef(null)
  const urlRef = useRef(null)
  // Session ID guards against stale callbacks from old speak() calls
  const sessionIdRef = useRef(0)

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      try { audioRef.current.pause() } catch (e) { /* ignore */ }
      audioRef.current = null
    }
    if (urlRef.current) {
      try { URL.revokeObjectURL(urlRef.current) } catch (e) { /* ignore */ }
      urlRef.current = null
    }
  }, [])

  const speak = useCallback(async (text) => {
    if (!text) {
      onEnd?.()
      return
    }
    if (!apiKey) {
      onEnd?.()
      return
    }

    // Each speak call gets a unique session — older in-flight callbacks become no-ops
    const session = ++sessionIdRef.current
    cleanupAudio()

    let audioUrl = null
    try {
      audioUrl = await synthesizeSpeech(text, voice || 'nova', apiKey)
      // Superseded while fetching? Drop it.
      if (session !== sessionIdRef.current) {
        try { URL.revokeObjectURL(audioUrl) } catch (e) {}
        return
      }

      urlRef.current = audioUrl
      const audio = new Audio(audioUrl)
      audioRef.current = audio

      audio.onended = () => {
        if (session !== sessionIdRef.current) return
        cleanupAudio()
        onEnd?.()
      }
      audio.onerror = () => {
        if (session !== sessionIdRef.current) return
        cleanupAudio()
        onError?.('Audio playback error')
      }

      try {
        await audio.play()
      } catch (playErr) {
        if (session !== sessionIdRef.current) return
        cleanupAudio()
        onError?.(playErr?.message || 'Audio play rejected (autoplay policy?)')
      }
    } catch (err) {
      if (session !== sessionIdRef.current) return
      cleanupAudio()
      onError?.(err?.message || 'TTS error')
    }
  }, [onEnd, onError, apiKey, voice, cleanupAudio])

  const cancel = useCallback(() => {
    // Invalidate in-flight callbacks so they can't fire
    sessionIdRef.current++
    cleanupAudio()
  }, [cleanupAudio])

  return { speak, cancel }
}
