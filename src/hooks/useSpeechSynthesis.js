import { useRef, useCallback } from 'react'
import { synthesizeSpeech } from '../services/openai'

export function useSpeechSynthesis({ onEnd, onError, apiKey, voice }) {
  const audioRef = useRef(null)
  const urlRef = useRef(null)

  const speak = useCallback(async (text) => {
    if (!text) return

    // Cancel any current playback
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }

    if (!apiKey) {
      onEnd?.()
      return
    }

    try {
      const audioUrl = await synthesizeSpeech(text, voice || 'nova', apiKey)
      urlRef.current = audioUrl

      const audio = new Audio(audioUrl)
      audioRef.current = audio

      audio.onended = () => {
        audioRef.current = null
        URL.revokeObjectURL(audioUrl)
        urlRef.current = null
        onEnd?.()
      }

      audio.onerror = (e) => {
        audioRef.current = null
        URL.revokeObjectURL(audioUrl)
        urlRef.current = null
        onError?.(e.message || 'Audio playback error')
      }

      await audio.play()
    } catch (err) {
      onError?.(err.message || 'TTS error')
    }
  }, [onEnd, onError, apiKey, voice])

  const cancel = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current.onended = null
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  return { speak, cancel }
}
