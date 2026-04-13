import { useRef, useCallback } from 'react'
import { synthesizeSpeech } from '../services/openai'

function dlog(msg) {
  if (window.__debugLog) window.__debugLog('TTS', msg)
}

// ===== AudioContext approach for reliable cross-platform playback =====
let audioCtx = null
let audioCtxUnlocked = false

// Also keep an Audio element fallback for browsers where AudioContext decoding fails
let globalAudio = null

function getAudioContext() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext
    if (AC) {
      audioCtx = new AC()
      dlog(`AudioContext created, state: ${audioCtx.state}`)
    } else {
      dlog('WARN AudioContext not available')
    }
  }
  return audioCtx
}

function getGlobalAudio() {
  if (!globalAudio) {
    globalAudio = new Audio()
  }
  return globalAudio
}

async function unlockAudioContext() {
  if (audioCtxUnlocked) return
  const ctx = getAudioContext()
  if (!ctx) return

  try {
    if (ctx.state === 'suspended') {
      await ctx.resume()
      dlog(`OK AudioContext resumed, state: ${ctx.state}`)
    }
    // Play a tiny silent buffer to fully unlock
    const buf = ctx.createBuffer(1, 1, 22050)
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    src.start(0)
    audioCtxUnlocked = true
    dlog('OK AudioContext unlocked with silent buffer')
  } catch (e) {
    dlog(`WARN AudioContext unlock failed: ${e.message}`)
  }

  // Also unlock Audio element as fallback
  try {
    const audio = getGlobalAudio()
    audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABhgC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7//////////////////////////////////////////////////////////////////8AAAAATGF2YzU4LjEzAAAAAAAAAAAAAAAAJAAAAAAAAAAAAYYoRwVHAAAAAAD/+1DEAAAH+AJ/UAAAIQQAT6gAABERERERERERERERERERERERERE='
    audio.volume = 0.01
    await audio.play()
    audio.pause()
    audio.currentTime = 0
    audio.volume = 1
    dlog('OK Audio element unlocked (fallback)')
  } catch (e) {
    dlog(`WARN Audio element unlock failed: ${e.message}`)
  }
}

// Unlock on first user interaction
if (typeof window !== 'undefined') {
  const unlock = () => {
    unlockAudioContext()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
    window.removeEventListener('touchstart', unlock)
  }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
  window.addEventListener('touchstart', unlock, { once: true })
}

export function useSpeechSynthesis({ onEnd, onError, apiKey, voice }) {
  const urlRef = useRef(null)
  const sourceRef = useRef(null)

  const speak = useCallback(async (text) => {
    dlog(`speak() called, text length: ${text?.length || 0}`)
    if (!text || !apiKey) {
      dlog('WARN No text or no API key')
      onEnd?.()
      return
    }

    // Clean up previous
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    if (sourceRef.current) {
      try { sourceRef.current.stop() } catch (e) {}
      sourceRef.current = null
    }

    try {
      dlog('Fetching TTS audio from OpenAI...')
      const audioUrl = await synthesizeSpeech(text, voice || 'nova', apiKey)
      urlRef.current = audioUrl
      dlog('OK TTS audio received')

      // Try AudioContext first (more reliable on iOS Safari)
      const ctx = getAudioContext()
      if (ctx) {
        try {
          // Resume if suspended
          if (ctx.state === 'suspended') {
            await ctx.resume()
            dlog(`AudioContext resumed from suspended, state: ${ctx.state}`)
          }

          dlog('Decoding audio with AudioContext...')
          const response = await fetch(audioUrl)
          const arrayBuffer = await response.arrayBuffer()
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer)
          dlog(`OK Decoded: ${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.sampleRate}Hz`)

          const source = ctx.createBufferSource()
          source.buffer = audioBuffer
          source.connect(ctx.destination)
          sourceRef.current = source

          source.onended = () => {
            dlog('OK AudioContext playback ended')
            URL.revokeObjectURL(audioUrl)
            urlRef.current = null
            sourceRef.current = null
            onEnd?.()
          }

          source.start(0)
          dlog('OK AudioContext playback started')
          return // Success via AudioContext
        } catch (e) {
          dlog(`WARN AudioContext playback failed: ${e.message}, falling back to Audio element`)
        }
      }

      // Fallback: Audio element
      dlog('Using Audio element fallback...')
      const audio = getGlobalAudio()
      audio.src = audioUrl
      audio.volume = 1

      audio.onended = () => {
        dlog('OK Audio element playback ended')
        URL.revokeObjectURL(audioUrl)
        urlRef.current = null
        onEnd?.()
      }

      audio.onerror = (e) => {
        dlog(`ERROR Audio element error: ${e.type}`)
        URL.revokeObjectURL(audioUrl)
        urlRef.current = null
        onError?.(e.message || 'Audio playback error')
      }

      await audio.play()
      dlog('OK Audio element playback started')
    } catch (err) {
      dlog(`ERROR TTS failed: ${err.message}`)
      onError?.(err.message || 'TTS error')
    }
  }, [onEnd, onError, apiKey, voice])

  const cancel = useCallback(() => {
    dlog('cancel() called')
    // Stop AudioContext source
    if (sourceRef.current) {
      try { sourceRef.current.stop() } catch (e) {}
      sourceRef.current = null
    }
    // Stop Audio element
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
