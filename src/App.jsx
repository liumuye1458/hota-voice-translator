// src/App.jsx — v3.0
//
// Thin composition root. All translation state owned by useTranslator hook.
// This component just:
//   - holds user settings + message history (persistent)
//   - maps FSM status to UI status
//   - wires button events to hook dispatchers
//   - manages the input field, error/fallback banners, audio unlock, Esc/blur reset

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslator } from './hooks/useTranslator'
import { LANGUAGES, SOURCE_LANG, isMobileDevice } from './config/languages'
import { audioEngine } from './core/audioEngine'
import { DEFAULT_TRANSLATION_MODEL, DEFAULT_STT_MODEL, TRANSLATION_MODELS } from './core/modelRouter'
import { probeModel } from './services/openai'
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

  // Track which message is currently being replayed (for UI feedback)
  const [replayingMessageId, setReplayingMessageId] = useState(null)

  // Sticky model-fallback notice (PRD-002 §5.1). Shown once per page session.
  const [fallbackNotice, setFallbackNotice] = useState(null)
  const handleModelFallback = useCallback((ev) => setFallbackNotice(ev), [])

  const translationModel = settings.translationModel || DEFAULT_TRANSLATION_MODEL
  const sttModel = settings.sttModel || DEFAULT_STT_MODEL

  // ====== The hook =====
  const {
    state: tState,
    sendText,
    startVoice,
    stopVoice,
    cancelVoice,
    replay,
    resetModelRouting,
    forceReset
  } = useTranslator({
    apiKey: settings.apiKey,
    voice: settings.voice || 'nova',
    customInstructions: settings.customInstructions || '',
    targetLangCode,
    sttPrompt: settings.sttVocabulary || '',
    translationModel,
    sttModel,
    onTranslationDone: handleTranslationDone,
    onModelFallback: handleModelFallback,
    onError: showError
  })

  // Settings "检测可用模型": probe each translation model, then clear this
  // session's downgrade so the next translation tries the preferred model again.
  const handleCheckModels = useCallback(async () => {
    const results = {}
    for (const m of TRANSLATION_MODELS) {
      results[m.id] = await probeModel(m.id, settings.apiKey)
    }
    resetModelRouting()
    setFallbackNotice(null)
    return results
  }, [settings.apiKey, resetModelRouting])

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

  const handleReplay = useCallback((text, direction, messageId) => {
    setReplayingMessageId(messageId ?? null)
    replay(text, direction)
  }, [replay])

  // Clear replayingMessageId when we return to idle (speaking finished or cancelled)
  useEffect(() => {
    if (tState.status === 'idle') {
      setReplayingMessageId(null)
    }
  }, [tState.status])

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
      {fallbackNotice && (
        <div
          className="error-banner"
          style={{ background: 'rgba(255,165,0,0.15)', borderColor: 'rgba(255,165,0,0.3)', color: '#ffaa44', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span style={{ flex: 1 }}>
            当前 API Key 暂不支持 {fallbackNotice.from}，已自动切到 {fallbackNotice.to}。本页会继续使用 {fallbackNotice.to}，可在设置中重新检测。
          </span>
          <button
            onClick={() => setFallbackNotice(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14 }}
            aria-label="Dismiss"
          >✕</button>
        </div>
      )}
      <ConversationView
        messages={messages}
        interimText={''}
        state={uiStatus}
        onDeleteMessage={handleDeleteMessage}
        onReplay={handleReplay}
        replayingMessageId={replayingMessageId}
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
        onCheckModels={handleCheckModels}
      />
    </div>
  )
}
