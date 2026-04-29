import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useSpeechRecognition } from './hooks/useSpeechRecognition'
import { useSpeechSynthesis } from './hooks/useSpeechSynthesis'
import { useTranslation } from './hooks/useTranslation'
import { LANGUAGES, SOURCE_LANG, getLangName, isMobileDevice } from './config/languages'
import StatusBar from './components/StatusBar'
import ConversationView from './components/ConversationView'
import DualVoiceButton from './components/DualVoiceButton'
import SettingsPanel from './components/SettingsPanel'
import TextInputBar from './components/TextInputBar'
import RecognitionStatus from './components/RecognitionStatus'

const LS_SETTINGS = 'vt_settings'
const LS_MESSAGES = 'vt_messages'

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(LS_SETTINGS)) || {} }
  catch { return {} }
}
function loadMessages() {
  try { return JSON.parse(localStorage.getItem(LS_MESSAGES)) || [] }
  catch { return [] }
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [messages, setMessages] = useState(loadMessages)
  const [state, setState] = useState('idle') // idle | listening | translating | speaking | error
  const [activeButton, setActiveButton] = useState(null) // 'left' | 'right' | null
  const [interimText, setInterimText] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [inputText, setInputText] = useState('')
  const [refocusToken, setRefocusToken] = useState(0)

  const isMobile = useMemo(() => isMobileDevice(), [])
  const stateRef = useRef('idle')
  const activeButtonRef = useRef(null)
  const idCounter = useRef(messages.length)
  // Guards against concurrent send-text invocations (rapid Shift taps)
  const sendInFlightRef = useRef(false)

  // Target language (right button), default Indonesian
  const targetLangCode = settings.targetLang || 'id-ID'
  const targetLang = LANGUAGES.find(l => l.code === targetLangCode) || LANGUAGES[0]

  const updateSettings = useCallback((partial) => {
    setSettings(prev => {
      const next = { ...prev, ...partial }
      localStorage.setItem(LS_SETTINGS, JSON.stringify(next))
      return next
    })
  }, [])

  // Persist messages
  const saveTimeoutRef = useRef(null)
  useEffect(() => {
    clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      localStorage.setItem(LS_MESSAGES, JSON.stringify(messages.slice(-200)))
    }, 1000)
  }, [messages])

  const updateState = useCallback((newState) => {
    stateRef.current = newState
    setState(newState)
  }, [])

  const showError = useCallback((msg) => {
    setErrorMsg(msg)
    setTimeout(() => setErrorMsg(''), 5000)
  }, [])

  // Translation
  const { translate } = useTranslation(settings.apiKey)

  // TTS
  const { speak, cancel: cancelSpeech } = useSpeechSynthesis({
    apiKey: settings.apiKey,
    voice: settings.voice || 'nova',
    onEnd: () => {
      updateState('idle')
      setActiveButton(null)
      activeButtonRef.current = null
      // Refocus input so user can resume WeChat dictation
      setRefocusToken(t => t + 1)
    },
    onError: (err) => {
      console.error('TTS error:', err)
      showError(`语音合成失败 / TTS: ${err}`)
      updateState('idle')
      setActiveButton(null)
      activeButtonRef.current = null
    }
  })

  // Speech recognition final callback
  const handleFinal = useCallback(async (text) => {
    if (!text.trim()) return
    if (stateRef.current !== 'listening') return
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true

    recognitionRef.current?.stop()
    setInterimText('')
    updateState('translating')

    const side = activeButtonRef.current
    // Left = Chinese → target, Right = target → Chinese
    const sourceLangName = side === 'left' ? getLangName(SOURCE_LANG.code) : getLangName(targetLangCode)
    const targetLangName = side === 'left' ? getLangName(targetLangCode) : getLangName(SOURCE_LANG.code)
    const fromLang = side === 'left' ? 'zh' : targetLangCode
    const toLang = side === 'left' ? targetLangCode : 'zh'

    try {
      const translation = await translate(text, sourceLangName, targetLangName)
      if (!translation) {
        updateState('idle')
        setActiveButton(null)
        activeButtonRef.current = null
        return
      }

      const msg = {
        id: ++idCounter.current,
        timestamp: Date.now(),
        originalText: text,
        translatedText: translation,
        fromLang,
        toLang
      }
      setMessages(prev => [...prev, msg])

      // Speak translation
      if (settings.autoPlay !== false) {
        updateState('speaking')
        speak(translation)
      } else {
        updateState('idle')
        setActiveButton(null)
        activeButtonRef.current = null
      }
    } catch (err) {
      console.error('Translation error:', err)
      showError(err.message || '翻译出错 / Translation error')
      updateState('error')
      setActiveButton(null)
      activeButtonRef.current = null
      setTimeout(() => {
        if (stateRef.current === 'error') updateState('idle')
      }, 3000)
    } finally {
      sendInFlightRef.current = false
    }
  }, [translate, speak, updateState, showError, targetLangCode, settings])

  const { start: startRecognition, stop: stopRecognition, isSupported } = useSpeechRecognition({
    onInterim: (text) => setInterimText(text),
    onFinal: handleFinal,
    onError: (err) => {
      console.error('Recognition error:', err)
      if (err === 'not-allowed') {
        showError('麦克风权限被拒绝 / Microphone permission denied')
      }
      updateState('idle')
      setActiveButton(null)
      activeButtonRef.current = null
    }
  })

  const recognitionRef = useRef({ start: startRecognition, stop: stopRecognition })
  recognitionRef.current = { start: startRecognition, stop: stopRecognition }

  // Press start: begin listening
  const handlePressStart = useCallback((side) => {
    if (stateRef.current !== 'idle') return
    activeButtonRef.current = side
    setActiveButton(side)
    updateState('listening')
    // Left = Chinese, Right = target language
    const lang = side === 'left' ? SOURCE_LANG.code : targetLangCode
    startRecognition(lang)
  }, [startRecognition, updateState, targetLangCode])

  // Press end: stop listening, process result
  const handlePressEnd = useCallback((side) => {
    if (stateRef.current !== 'listening') return
    stopRecognition()
    const text = interimText.trim()
    if (text) {
      setInterimText('')
      handleFinal(text)
    } else {
      updateState('idle')
      setActiveButton(null)
      activeButtonRef.current = null
    }
  }, [stopRecognition, interimText, handleFinal, updateState])

  // Text input send: Chinese → target (used by WeChat voice / keyboard typing)
  const handleSendText = useCallback(async (explicitText) => {
    const text = (explicitText ?? inputText).trim()
    if (!text) return
    // Prevent concurrent sends (e.g. double Shift tap)
    if (sendInFlightRef.current) return
    sendInFlightRef.current = true

    // Cancel whatever is going on — voice listening or current audio
    if (stateRef.current === 'listening') {
      stopRecognition()
      setInterimText('')
    }
    if (stateRef.current === 'speaking') {
      cancelSpeech()
    }

    // Clear input immediately so next voice-dictation can start fresh
    setInputText('')

    // Lock into Chinese → target flow
    activeButtonRef.current = 'left'
    setActiveButton('left')
    updateState('translating')

    const sourceLangName = getLangName(SOURCE_LANG.code)
    const targetLangName = getLangName(targetLangCode)

    try {
      const translation = await translate(text, sourceLangName, targetLangName)
      if (!translation) {
        updateState('idle')
        setActiveButton(null)
        activeButtonRef.current = null
        return
      }
      const msg = {
        id: ++idCounter.current,
        timestamp: Date.now(),
        originalText: text,
        translatedText: translation,
        fromLang: 'zh',
        toLang: targetLangCode
      }
      setMessages(prev => [...prev, msg])
      if (settings.autoPlay !== false) {
        updateState('speaking')
        speak(translation)
      } else {
        updateState('idle')
        setActiveButton(null)
        activeButtonRef.current = null
      }
    } catch (err) {
      console.error('Translation error:', err)
      showError(err.message || '翻译出错 / Translation error')
      updateState('error')
      setActiveButton(null)
      activeButtonRef.current = null
      setTimeout(() => {
        if (stateRef.current === 'error') updateState('idle')
      }, 3000)
    } finally {
      sendInFlightRef.current = false
    }
  }, [inputText, translate, speak, cancelSpeech, stopRecognition, updateState, showError, targetLangCode, settings])

  // Cancel: stop listening, clear interim, restart recognition (Shift still held)
  const handleCancel = useCallback((side) => {
    if (stateRef.current !== 'listening') return
    stopRecognition()
    setInterimText('')
    // Restart recognition — user's Shift is still held (PC) or they can press again (mobile)
    updateState('idle')
    setActiveButton(null)
    activeButtonRef.current = null
  }, [stopRecognition, updateState])

  // Replay a message
  const handleReplay = useCallback((message) => {
    if (stateRef.current === 'speaking') cancelSpeech()
    if (stateRef.current === 'listening') stopRecognition()
    updateState('speaking')
    speak(message.translatedText)
  }, [speak, cancelSpeech, stopRecognition, updateState])

  const handleDeleteMessage = useCallback((id, timestamp) => {
    setMessages(prev => {
      const filtered = prev.filter(m => {
        if (id != null && m.id === id) return false
        if (id == null && timestamp && m.timestamp === timestamp) return false
        return true
      })
      localStorage.setItem(LS_MESSAGES, JSON.stringify(filtered.slice(-200)))
      return filtered
    })
  }, [])

  const handleClearHistory = useCallback(() => {
    setMessages([])
    localStorage.removeItem(LS_MESSAGES)
    idCounter.current = 0
  }, [])

  if (!isSupported) {
    return (
      <div className="app-shell">
        <div className="conversation__empty" style={{ height: '100dvh' }}>
          此浏览器不支持语音识别<br />
          请使用 Chrome 或 Edge 浏览器<br /><br />
          This browser does not support speech recognition.<br />
          Please use Chrome or Edge.
        </div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <StatusBar state={state} onOpenSettings={() => setSettingsOpen(true)} />
      {!settings.apiKey && (
        <div className="error-banner" style={{ background: 'rgba(255,165,0,0.15)', borderColor: 'rgba(255,165,0,0.3)', color: '#ffaa44', cursor: 'pointer' }} onClick={() => setSettingsOpen(true)}>
          请设置 API Key / Set API Key in Settings ⚙
        </div>
      )}
      {errorMsg && <div className="error-banner">{errorMsg}</div>}
      <ConversationView
        messages={messages}
        interimText={interimText}
        state={state}
        onReplay={handleReplay}
        onDeleteMessage={handleDeleteMessage}
      />
      <TextInputBar
        value={inputText}
        onChange={setInputText}
        onSend={(text) => handleSendText(text)}
        disabled={state === 'translating'}
        refocusToken={refocusToken}
      />
      <DualVoiceButton
        leftLabel={`${SOURCE_LANG.flag} ${SOURCE_LANG.name}`}
        rightLabel={`${targetLang.flag} ${targetLang.name}`}
        activeButton={activeButton}
        state={state}
        isMobile={isMobile}
        interimText={interimText}
        hasInputText={inputText.trim().length > 0}
        onPressStart={handlePressStart}
        onPressEnd={handlePressEnd}
        onCancel={handleCancel}
        onSendText={() => handleSendText()}
      />
      <RecognitionStatus />
      <SettingsPanel
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onUpdateSettings={updateSettings}
        onClearHistory={handleClearHistory}
      />
    </div>
  )
}
