import { useRef, useCallback } from 'react'
import { translateText } from '../services/openai'

export function useTranslation(apiKey) {
  const isTranslatingRef = useRef(false)

  const translate = useCallback(async (text, sourceLang, targetLang) => {
    if (isTranslatingRef.current) return null
    isTranslatingRef.current = true

    try {
      if (!apiKey) {
        return `[未设置API Key] ${text}`
      }
      return await translateText(text, sourceLang, targetLang, apiKey)
    } finally {
      isTranslatingRef.current = false
    }
  }, [apiKey])

  return { translate }
}
