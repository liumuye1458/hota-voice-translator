import { useState, useCallback } from 'react'

export default function MessageBubble({ message, onDelete, onReplay, isReplaying }) {
  const { originalText, translatedText, fromLang, toLang, timestamp } = message
  const isZh = fromLang === 'zh'
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const [copied, setCopied] = useState(false)

  const handleDelete = useCallback((e) => {
    e.stopPropagation()
    onDelete?.(message.id, message.timestamp)
  }, [onDelete, message.id, message.timestamp])

  const handleReplay = useCallback((e) => {
    e.stopPropagation()
    // Derive direction from message metadata: fromLang is the SOURCE language,
    // so playback direction is fromLang → toLang (i.e. the same direction as
    // the original translation used).
    const direction = fromLang === 'zh' ? 'zh→id' : 'id→zh'
    onReplay?.(translatedText, direction, message.id)
  }, [onReplay, translatedText, fromLang, message.id])

  // Copy "original\ntranslation" to clipboard. Fall back to legacy execCommand for
  // browsers/contexts where navigator.clipboard is unavailable (rare, mostly non-HTTPS).
  const handleCopy = useCallback(async (e) => {
    e.stopPropagation()
    const text = `${originalText}\n${translatedText}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.focus()
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('copy failed:', err)
    }
  }, [originalText, translatedText])

  return (
    <div className={`message-bubble message-bubble--${isZh ? 'zh' : 'id'}`}>
      <div className="message-bubble__actions">
        <button
          className={`message-bubble__action message-bubble__action--replay ${isReplaying ? 'message-bubble__action--replaying' : ''}`}
          onClick={handleReplay}
          title={isReplaying ? '正在播放 / Playing…' : '重播译文 / Replay translation'}
          aria-label={isReplaying ? 'Playing' : 'Replay'}
        >
          {isReplaying ? '❚❚' : '🔊'}
        </button>
        <button
          className={`message-bubble__action message-bubble__action--copy ${copied ? 'message-bubble__action--copied' : ''}`}
          onClick={handleCopy}
          title="复制原文与译文 / Copy both texts"
          aria-label="Copy"
        >
          {copied ? '✓' : '⧉'}
        </button>
        <button
          className="message-bubble__action message-bubble__action--delete"
          onClick={handleDelete}
          title="删除 / Delete"
          aria-label="Delete"
        >
          ✕
        </button>
      </div>
      <div className="message-bubble__original">{originalText}</div>
      <div className="message-bubble__translation">{translatedText}</div>
      <div className="message-bubble__time">{timeStr}</div>
    </div>
  )
}
