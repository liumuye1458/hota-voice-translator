import { useState, useEffect } from 'react'

const listeners = new Set()
let lastEvent = null
let history = []

export function emitRecEvent(tag, detail = '') {
  const time = new Date().toLocaleTimeString('en', { hour12: false })
  const entry = { time, tag, detail: String(detail).substring(0, 40) }
  lastEvent = entry
  history = [...history.slice(-9), entry]
  listeners.forEach(fn => fn({ last: entry, history }))
}

export default function RecognitionStatus() {
  const [state, setState] = useState({ last: null, history: [] })
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    const fn = (s) => setState(s)
    listeners.add(fn)
    return () => listeners.delete(fn)
  }, [])

  if (!state.last) return null

  const tagColor = (tag) => {
    if (tag.includes('ERR')) return '#ff6666'
    if (tag.includes('start') || tag.includes('result')) return '#66ff66'
    if (tag.includes('end') || tag.includes('stop')) return '#aaa'
    return '#ffaa44'
  }

  return (
    <div
      onClick={() => setExpanded(v => !v)}
      style={{
        position: 'fixed',
        top: 52,
        right: 8,
        zIndex: 998,
        background: 'rgba(0,0,0,0.78)',
        border: '1px solid rgba(255,107,0,0.4)',
        borderRadius: 6,
        padding: expanded ? '6px 10px' : '3px 8px',
        fontFamily: 'monospace',
        fontSize: 10,
        color: '#ddd',
        maxWidth: expanded ? 320 : 180,
        cursor: 'pointer',
        lineHeight: 1.4
      }}
      title="点击展开识别日志"
    >
      {!expanded ? (
        <span>
          <span style={{ color: tagColor(state.last.tag) }}>● </span>
          <span style={{ color: '#fff' }}>{state.last.tag}</span>
          {state.last.detail && <span style={{ color: '#888' }}> {state.last.detail}</span>}
        </span>
      ) : (
        <div>
          <div style={{ color: '#ff6b00', fontSize: 9, marginBottom: 4 }}>STT EVENTS (点击收起)</div>
          {state.history.map((e, i) => (
            <div key={i} style={{ color: tagColor(e.tag) }}>
              {e.time.split(' ')[0]} {e.tag} <span style={{ color: '#888' }}>{e.detail}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
