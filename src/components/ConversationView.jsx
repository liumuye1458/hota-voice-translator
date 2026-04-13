import { useRef, useEffect } from 'react'
import MessageBubble from './MessageBubble'

export default function ConversationView({ messages, interimText, state, onReplay, onDeleteMessage }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, interimText])

  return (
    <>
      <div className="conversation">
        {messages.length === 0 && !interimText && (
          <div className="conversation__empty">
            点击麦克风开始翻译<br />
            Tap the mic to start translating
          </div>
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id || msg.timestamp || Math.random()} message={msg} onDelete={onDeleteMessage} />
        ))}
        <div ref={bottomRef} />
      </div>
      <div className="interim-text">
        {state === 'listening' && interimText && (
          <div className="interim-text__content">{interimText}</div>
        )}
      </div>
    </>
  )
}
