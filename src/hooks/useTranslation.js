import { useRef, useCallback } from 'react'
import { translateText } from '../services/openai'

export function useTranslation(apiKey, customInstructions = '') {
  const isTranslatingRef = useRef(false)

  const translate = useCallback(async (text, sourceLang, targetLang) => {
    if (isTranslatingRef.current) return null
    isTranslatingRef.current = true

    try {
      if (!apiKey) {
        return `[未设置API Key] ${text}`
      }
      return await translateText(text, sourceLang, targetLang, apiKey, customInstructions)
    } finally {
      isTranslatingRef.current = false
    }
  }, [apiKey, customInstructions])

  return { translate }
}
