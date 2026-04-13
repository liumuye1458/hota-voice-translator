import { useState } from 'react'
import { LANGUAGES } from '../config/languages'

const VOICES = [
  { id: 'nova', label: 'Nova', desc: '女声 · 温暖友好' },
  { id: 'shimmer', label: 'Shimmer', desc: '女声 · 柔和' },
  { id: 'alloy', label: 'Alloy', desc: '中性 · 清晰' },
  { id: 'echo', label: 'Echo', desc: '男声 · 沉稳' },
  { id: 'fable', label: 'Fable', desc: '男声 · 叙事感' },
  { id: 'onyx', label: 'Onyx', desc: '男声 · 低沉有力' }
]

export default function SettingsPanel({ isOpen, onClose, settings, onUpdateSettings, onClearHistory }) {
  const [keyVisible, setKeyVisible] = useState(false)

  const handleClear = () => {
    if (confirm('确定清空所有对话记录？\nClear all conversation history?')) {
      onClearHistory()
    }
  }

  const apiKey = settings.apiKey || ''
  const maskedKey = apiKey ? apiKey.slice(0, 7) + '...' + apiKey.slice(-4) : ''

  return (
    <>
      <div
        className={`settings-overlay ${isOpen ? 'settings-overlay--open' : ''}`}
        onClick={onClose}
      />
      <div className={`settings-panel ${isOpen ? 'settings-panel--open' : ''}`}>
        <div className="settings-panel__header">
          <div className="settings-panel__title">设置 / Settings</div>
          <button className="settings-panel__close" onClick={onClose}>✕</button>
        </div>
        <div className="settings-panel__body">

          {/* API Key */}
          <div className="settings-section">
            <label className="settings-label">OpenAI API Key</label>
            <div className="settings-input-row">
              <input
                type={keyVisible ? 'text' : 'password'}
                className="settings-input"
                placeholder="sk-..."
                value={apiKey}
                onChange={e => onUpdateSettings({ apiKey: e.target.value.trim() })}
              />
              <button
                className="settings-btn-sm"
                onClick={() => setKeyVisible(!keyVisible)}
              >
                {keyVisible ? '隐藏' : '显示'}
              </button>
            </div>
            {apiKey
              ? <div className="settings-hint settings-hint--ok">✓ 已设置 ({maskedKey})</div>
              : <div className="settings-hint">需要 API Key 才能翻译和语音</div>
            }
          </div>

          {/* Target Language */}
          <div className="settings-section">
            <label className="settings-label">目标语言 / Target Language</label>
            <select
              className="settings-select"
              value={settings.targetLang || 'id-ID'}
              onChange={e => onUpdateSettings({ targetLang: e.target.value })}
            >
              {LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code}>
                  {lang.flag} {lang.nameZh} — {lang.name}
                </option>
              ))}
            </select>
            <div className="settings-hint">左键 = 中文，右键 = 目标语言</div>
          </div>

          {/* Engine */}
          <div className="settings-section">
            <label className="settings-label">翻译引擎 / Engine</label>
            <div className="settings-hint" style={{ fontSize: '13px', color: 'var(--color-success)' }}>
              GPT-4o（高质量翻译）
            </div>
          </div>

          {/* TTS Voice */}
          <div className="settings-section">
            <label className="settings-label">语音 / Voice</label>
            <div className="settings-voice-options" style={{ flexWrap: 'wrap' }}>
              {VOICES.map(v => (
                <button
                  key={v.id}
                  className={`settings-voice-btn ${(settings.voice || 'nova') === v.id ? 'settings-voice-btn--active' : ''}`}
                  onClick={() => onUpdateSettings({ voice: v.id })}
                >
                  {v.label}
                  <span className="settings-voice-sub">{v.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Auto Play */}
          <div className="settings-section">
            <label className="settings-label-row">
              <span>自动播报 / Auto Speak</span>
              <input
                type="checkbox"
                className="settings-checkbox"
                checked={settings.autoPlay !== false}
                onChange={e => onUpdateSettings({ autoPlay: e.target.checked })}
              />
            </label>
          </div>

          {/* Clear History */}
          <div className="settings-section">
            <button className="settings-btn-danger" onClick={handleClear}>
              清空对话 / Clear History
            </button>
          </div>

        </div>
      </div>
    </>
  )
}
