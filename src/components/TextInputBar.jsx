import { useEffect, useRef } from 'react'

export default function TextInputBar({ value, onChange, onSend, disabled }) {
  const inputRef = useRef(null)

  // Auto-focus on mount and on state recovery
  useEffect(() => {
    if (inputRef.current && !disabled) {
      inputRef.current.focus()
    }
  }, [disabled])

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault()
      if (value.trim()) {
        onSend(value.trim())
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onChange('')
    }
  }

  const handleSendClick = () => {
    if (value.trim()) {
      onSend(value.trim())
    }
    inputRef.current?.focus()
  }

  return (
    <div className="text-input-bar">
      <input
        ref={inputRef}
        type="text"
        className="text-input-bar__input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="中文输入（Ctrl+Win 语音 · 敲左Shift或回车发送）"
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      <button
        className="text-input-bar__send"
        onClick={handleSendClick}
        disabled={disabled || !value.trim()}
        title="发送翻译 (Enter / 左Shift)"
      >
        →
      </button>
    </div>
  )
}
