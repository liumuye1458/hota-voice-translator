import { useState, useEffect, useRef, useCallback } from 'react'

// Global debug log array — other modules push to this
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

// Attach to window for easy access from other modules
if (typeof window !== 'undefined') {
  window.__debugLog = debugLog
}

export default function DebugPanel() {
  const [visible, setVisible] = useState(false)
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
  }, [entries])

  // Triple-tap title bar to toggle debug panel
  const handleTitleTap = useCallback(() => {
    tapCount.current++
    clearTimeout(tapTimer.current)
    tapTimer.current = setTimeout(() => { tapCount.current = 0 }, 600)
    if (tapCount.current >= 3) {
      tapCount.current = 0
      setVisible(v => !v)
    }
  }, [])

  // Expose the toggle trigger globally so StatusBar can use it
  useEffect(() => {
    window.__toggleDebug = () => setVisible(v => !v)
    window.__debugTap = handleTitleTap
    return () => {
      delete window.__toggleDebug
      delete window.__debugTap
    }
  }, [handleTitleTap])

  if (!visible) return null

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      height: '40dvh',
      background: 'rgba(0,0,0,0.92)',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
      borderTop: '2px solid #ff6b00',
      fontFamily: 'monospace',
      fontSize: '11px'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '4px 10px',
        background: 'rgba(255,107,0,0.15)',
        flexShrink: 0
      }}>
        <span style={{ color: '#ff6b00', fontWeight: 'bold' }}>DEBUG</span>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => { logs.length = 0; setEntries([]) }} style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.2)',
            color: '#aaa', borderRadius: '4px', padding: '2px 8px', fontSize: '10px', cursor: 'pointer'
          }}>Clear</button>
          <button onClick={() => setVisible(false)} style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.2)',
            color: '#aaa', borderRadius: '4px', padding: '2px 8px', fontSize: '10px', cursor: 'pointer'
          }}>Close</button>
        </div>
      </div>
      <div ref={scrollRef} style={{
        flex: 1,
        overflowY: 'auto',
        padding: '6px 10px',
        color: '#0f0',
        lineHeight: '1.5',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all'
      }}>
        {entries.length === 0 && <span style={{ color: '#666' }}>No logs yet. Start using the app to see debug output.</span>}
        {entries.map((line, i) => (
          <div key={i} style={{
            color: line.includes('ERROR') ? '#f44' : line.includes('WARN') ? '#fa0' : line.includes('OK') ? '#0f0' : '#8f8'
          }}>{line}</div>
        ))}
      </div>
    </div>
  )
}
