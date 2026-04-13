import { useState, useEffect, useRef, useCallback } from 'react'

const MAX_LOGS = 80
const logs = []
const listeners = new Set()

export function debugLog(tag, msg) {
  const time = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const entry = `[${time}] ${tag}: ${msg}`
  logs.push(entry)
  if (logs.length > MAX_LOGS) logs.shift()
  listeners.forEach(fn => fn([...logs]))
}

if (typeof window !== 'undefined') {
  window.__debugLog = debugLog
}

export default function DebugPanel() {
  const [visible, setVisible] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [entries, setEntries] = useState([])
  const scrollRef = useRef(null)
  const tapCount = useRef(0)
  const tapTimer = useRef(null)

  useEffect(() => {
    listeners.add(setEntries)
    return () => listeners.delete(setEntries)
  }, [])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [entries, expanded])

  const handleTitleTap = useCallback(() => {
    tapCount.current++
    clearTimeout(tapTimer.current)
    tapTimer.current = setTimeout(() => { tapCount.current = 0 }, 600)
    if (tapCount.current >= 3) {
      tapCount.current = 0
      setVisible(v => !v)
    }
  }, [])

  useEffect(() => {
    window.__toggleDebug = () => setVisible(v => !v)
    window.__debugTap = handleTitleTap
    return () => {
      delete window.__toggleDebug
      delete window.__debugTap
    }
  }, [handleTitleTap])

  if (!visible) return null

  // Compact mode: thin bar at top showing last log line
  // Expanded mode: scrollable log overlay (top half, not blocking buttons)
  if (!expanded) {
    const lastLine = entries.length > 0 ? entries[entries.length - 1] : 'No logs yet'
    return (
      <div
        onClick={() => setExpanded(true)}
        style={{
          position: 'fixed',
          top: 48,
          left: 0,
          right: 0,
          zIndex: 9999,
          background: 'rgba(0,0,0,0.88)',
          borderBottom: '1px solid #ff6b00',
          padding: '4px 10px',
          fontFamily: 'monospace',
          fontSize: '10px',
          color: '#0f0',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{lastLine}</span>
        <span style={{ color: '#ff6b00', marginLeft: 8, flexShrink: 0, fontSize: '9px' }}>
          [{entries.length}] TAP展开
        </span>
      </div>
    )
  }

  // Expanded: top area, max 35% height, NOT covering bottom buttons
  return (
    <div style={{
      position: 'fixed',
      top: 48,
      left: 0,
      right: 0,
      maxHeight: '35dvh',
      zIndex: 9999,
      background: 'rgba(0,0,0,0.92)',
      borderBottom: '2px solid #ff6b00',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'monospace',
      fontSize: '10px'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '3px 10px',
        background: 'rgba(255,107,0,0.15)',
        flexShrink: 0
      }}>
        <span style={{ color: '#ff6b00', fontWeight: 'bold', fontSize: '10px' }}>DEBUG [{entries.length}]</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button onClick={() => { logs.length = 0; setEntries([]) }} style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.2)',
            color: '#aaa', borderRadius: '3px', padding: '1px 6px', fontSize: '9px', cursor: 'pointer'
          }}>Clear</button>
          <button onClick={() => setExpanded(false)} style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.2)',
            color: '#aaa', borderRadius: '3px', padding: '1px 6px', fontSize: '9px', cursor: 'pointer'
          }}>收起</button>
          <button onClick={() => setVisible(false)} style={{
            background: 'none', border: '1px solid rgba(255,68,68,0.4)',
            color: '#f66', borderRadius: '3px', padding: '1px 6px', fontSize: '9px', cursor: 'pointer'
          }}>关闭</button>
        </div>
      </div>
      <div ref={scrollRef} style={{
        flex: 1,
        overflowY: 'auto',
        padding: '4px 10px',
        color: '#0f0',
        lineHeight: '1.4',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all'
      }}>
        {entries.length === 0 && <span style={{ color: '#666' }}>No logs yet.</span>}
        {entries.map((line, i) => (
          <div key={i} style={{
            color: line.includes('ERROR') ? '#f44' : line.includes('WARN') ? '#fa0' : line.includes('OK') ? '#0f0' : '#8f8'
          }}>{line}</div>
        ))}
      </div>
    </div>
  )
}
