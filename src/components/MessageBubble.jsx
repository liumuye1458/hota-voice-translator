export default function MessageBubble({ message, onDelete }) {
  const { originalText, translatedText, fromLang, timestamp } = message
  const isZh = fromLang === 'zh'
  const timeStr = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

  const handleDelete = (e) => {
    e.stopPropagation()
    onDelete?.(message.id, message.timestamp)
  }

  return (
    <div className={`message-bubble message-bubble--${isZh ? 'zh' : 'id'}`}>
      <button
        className="message-bubble__delete"
        onClick={handleDelete}
        title="删除 / Delete"
      >✕</button>
      <div className="message-bubble__original">{originalText}</div>
      <div className="message-bubble__translation">{translatedText}</div>
      <div className="message-bubble__time">{timeStr}</div>
    </div>
  )
}
