// src/App.jsx — v2.0
//
// Thin composition root. All translation state owned by useTranslator hook.
// This component just:
//   - holds user settings + message history (persistent)
//   - maps FSM status to UI status
//   - wires button events to hook dispatchers
//   - manages the input field, error banners, audio unlock, Esc/blur reset

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslator } from './hooks/useTranslator'
import { LANGUAGES, SOURCE_LANG, isMobileDevice } from './config/languages'
import { audioEngine } from './core/audioEngine'
import StatusBar from './components/StatusBar'
import ConversationView from './components/ConversationView'
import DualVoiceButton from './components/DualVoiceButton'
import SettingsPanel from './components/SettingsPanel'
import TextInputBar from './components/TextInputBar'

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

// Map FSM status → UI status. The existing CSS uses 'listening', not
// 'recording'/'transcribing'; condense both into one UI state for visual continuity.
function uiStatusOf(fsmStatus) {
  if (fsmStatus === 'recording' || fsmStatus === 'transcribing') return 'listening'
  return fsmStatus
}

export default function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [messages, setMessages] = useState(loadMessages)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')
  const [inputText, setInputText] = useState('')
  const [refocusToken, setRefocusToken] = useState(0)

  const isMobile = useMemo(() => isMobileDevice(), [])
  const idCounter = useRef(messages.length)
  const saveTimeoutRef = useRef(null)

  // Target language
  const targetLangCode = settings.targetLang || 'id-ID'
  const targetLang = LANGUAGES.find(l => l.code === targetLangCode) || LANGUAGES[0]

  const updateSettings = useCallback((partial) => {
    setSettings(prev => {
      const next = { ...prev, ...partial }
      localStorage.setItem(LS_SETTINGS, JSON.stringify(next))
      return next
    })
  }, [])

  // Persist messages debounced
  useEffect(() => {
    clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      localStorage.setItem(LS_MESSAGES, JSON.stringify(messages.slice(-200)))
    }, 1000)
  }, [messages])

  const showError = useCallback((msg) => {
    setErrorMsg(msg)
    setTimeout(() => setErrorMsg(''), 5000)
  }, [])

  // Add a completed translation to history
  const handleTranslationDone = useCallback((result) => {
    setMessages(prev => [...prev, {
      id: ++idCounter.current,
      timestamp: Date.now(),
      originalText: result.originalText,
      translatedText: result.translatedText,
      fromLang: result.fromLang,
      toLang: result.toLang
    }])
  }, [])

  // ====== The hook =====
  const {
    state: tState,
    sendText,
    startVoice,
    stopVoice,
    cancelVoice,
    forceReset
  } = useTranslator({
    apiKey: settings.apiKey,
    voice: settings.voice || 'nova',
    customInstructions: settings.customInstructions || '',
    targetLangCode,
    sttPrompt: settings.sttVocabulary || '',
    onTranslationDone: handleTranslationDone,
    onError: showError
  })

  const uiStatus = uiStatusOf(tState.status)
  const activeButton = tState.session
    ? (tState.session.direction === 'zh→id' ? 'left' : 'right')
    : null

  // ====== Side effects =====

  // Refocus input after returning to idle (so user can resume WeChat dictation)
  useEffect(() => {
    if (tState.status === 'idle') {
      setRefocusToken(t => t + 1)
    }
  }, [tState.status])

  // Mobile audio unlock on first user gesture (idempotent)
  useEffect(() => {
    let cancelled = false
    const unlock = () => {
      if (cancelled) return
      audioEngine.unlock()
    }
    document.addEventListener('pointerdown', unlock, { once: true })
    document.addEventListener('keydown', unlock, { once: true })
    return () => {
      cancelled = true
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('keydown', unlock)
    }
  }, [])

  // Window blur → reset if recording
  useEffect(() => {
    const onBlur = () => {
      if (tState.status === 'recording' || tState.status === 'transcribing') {
        forceReset('window-blur')
      }
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [forceReset, tState.status])

  // Esc → reset
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && tState.status !== 'idle') {
        forceReset('user')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [forceReset, tState.status])

  // ====== UI Event Handlers =====
  const handlePressStart = useCallback((side) => {
    startVoice(side)
  }, [startVoice])

  const handlePressEnd = useCallback((_side) => {
    stopVoice()
  }, [stopVoice])

  const handleCancel = useCallback((_side) => {
    cancelVoice()
  }, [cancelVoice])

  const handleSendText = useCallback((text) => {
    const cleaned = (text || inputText).trim()
    if (!cleaned) return
    setInputText('')
    sendText(cleaned)
  }, [inputText, sendText])

  const handleClearHistory = useCallback(() => {
    setMessages([])
    localStorage.removeItem(LS_MESSAGES)
    idCounter.current = 0
  }, [])

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

  return (
    <div className="app-shell">
      <StatusBar
        state={uiStatus}
        onOpenSettings={() => setSettingsOpen(true)}
        onForceReset={() => forceReset('user')}
        targetLangLabel={`${targetLang.flag} ${targetLang.nameZh}`}
      />
      {!settings.apiKey && (
        <div
          className="error-banner"
          style={{ background: 'rgba(255,165,0,0.15)', borderColor: 'rgba(255,165,0,0.3)', color: '#ffaa44', cursor: 'pointer' }}
          onClick={() => setSettingsOpen(true)}
        >
          请设置 API Key / Set API Key in Settings ⚙
        </div>
      )}
      {errorMsg && <div className="error-banner">{errorMsg}</div>}
      <ConversationView
        messages={messages}
        interimText={''}
        state={uiStatus}
        onDeleteMessage={handleDeleteMessage}
      />
      <TextInputBar
        value={inputText}
        onChange={setInputText}
        onSend={(text) => handleSendText(text)}
        disabled={uiStatus === 'translating'}
        refocusToken={refocusToken}
      />
      <DualVoiceButton
        leftLabel={`${SOURCE_LANG.flag} ${SOURCE_LANG.name}`}
        rightLabel={`${targetLang.flag} ${targetLang.name}`}
        activeButton={activeButton}
        state={uiStatus}
        isMobile={isMobile}
        interimText={''}
        hasInputText={inputText.trim().length > 0}
        onPressStart={handlePressStart}
        onPressEnd={handlePressEnd}
        onCancel={handleCancel}
        onSendText={() => handleSendText(inputText)}
      />
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
