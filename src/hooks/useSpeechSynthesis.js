import { useRef, useCallback, useEffect } from 'react'
import { synthesizeSpeech } from '../services/openai'

// Pre-create a reusable Audio element to satisfy Safari's autoplay policy.
// Safari requires audio.play() to originate from a user gesture.
// By "unlocking" the audio on the first user touch/click, subsequent plays work.
let globalAudio = null
let audioUnlocked = false

function getGlobalAudio() {
  if (!globalAudio) {
    globalAudio = new Audio()
  }
  return globalAudio
}

function unlockAudio() {
  if (audioUnlocked) return
  const audio = getGlobalAudio()
  // Play a tiny silent buffer to unlock
  audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwVHAAAAAAD/+1DEAAAH+AJ/UAAAIQQAT6gAABERERERERERERERERERERERERE='
  audio.volume = 0.01
  audio.play().then(() => {
    audioUnlocked = true
    audio.pause()
    audio.currentTime = 0
    audio.volume = 1
  }).catch(() => {})
}

// Unlock audio on first user interaction
if (typeof window !== 'undefined') {
  const unlock = () => {
    unlockAudio()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
}

export function useSpeechSynthesis({ onEnd, onError, apiKey, voice }) {
  const urlRef = useRef(null)

  const speak = useCallback(async (text) => {
    if (!text || !apiKey) {
      onEnd?.()
      return
    }

    // Clean up previous
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }

    try {
      const audioUrl = await synthesizeSpeech(text, voice || 'nova', apiKey)
      urlRef.current = audioUrl

      const audio = getGlobalAudio()
      audio.src = audioUrl
      audio.volume = 1

      audio.onended = () => {
        URL.revokeObjectURL(audioUrl)
        urlRef.current = null
        onEnd?.()
      }

      audio.onerror = (e) => {
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
    const audio = getGlobalAudio()
    audio.pause()
    audio.onended = null
    audio.onerror = null
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  return { speak, cancel }
}
