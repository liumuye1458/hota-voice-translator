import { useRef, useCallback, useEffect, useState } from 'react'

const CANCEL_DRAG_THRESHOLD = 60 // px to drag before entering cancel zone

export default function DualVoiceButton({
  leftLabel,
  rightLabel,
  activeButton,
  state,
  isMobile,
  interimText,
  onPressStart,
  onPressEnd,
  onCancel
}) {
  const activeRef = useRef(null)
  const startPosRef = useRef({ x: 0, y: 0 })
  const [inCancelZone, setInCancelZone] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const cancelZoneRef = useRef(false)

  // ===== Cancel flash animation =====
  const triggerCancelFlash = useCallback(() => {
    setShowCancelled(true)
    setTimeout(() => setShowCancelled(false), 600)
  }, [])

  // ===== Perform cancel =====
  const doCancel = useCallback((side) => {
    triggerCancelFlash()
    onCancel(side)
  }, [onCancel, triggerCancelFlash])

  // ===== Mouse handlers =====
  const handleMouseDown = useCallback((side) => (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    activeRef.current = side
    startPosRef.current = { x: e.clientX, y: e.clientY }
    setInCancelZone(false)
    cancelZoneRef.current = false
    onPressStart(side)
  }, [onPressStart])

  const handleMouseMove = useCallback((e) => {
    if (!activeRef.current) return
    const dy = startPosRef.current.y - e.clientY // positive = dragged up
    const inZone = dy > CANCEL_DRAG_THRESHOLD
    if (inZone !== cancelZoneRef.current) {
      cancelZoneRef.current = inZone
      setInCancelZone(inZone)
    }
  }, [])

  const handleMouseUp = useCallback(() => {
    if (!activeRef.current) return
    const side = activeRef.current
    if (cancelZoneRef.current) {
      doCancel(side)
    } else {
      onPressEnd(side)
    }
    activeRef.current = null
    setInCancelZone(false)
    cancelZoneRef.current = false
  }, [onPressEnd, doCancel])

  // ===== Touch handlers =====
  const handleTouchStart = useCallback((side) => (e) => {
    // Do NOT call preventDefault() here — it blocks mic permission on Android Chrome
    const touch = e.touches[0]
    activeRef.current = side
    startPosRef.current = { x: touch.clientX, y: touch.clientY }
    setInCancelZone(false)
    cancelZoneRef.current = false
    onPressStart(side)
  }, [onPressStart])

  const handleTouchMove = useCallback((e) => {
    if (!activeRef.current) return
    const touch = e.touches[0]
    const dy = startPosRef.current.y - touch.clientY
    const inZone = dy > CANCEL_DRAG_THRESHOLD
    if (inZone !== cancelZoneRef.current) {
      cancelZoneRef.current = inZone
      setInCancelZone(inZone)
    }
  }, [])

  const handleTouchEnd = useCallback(() => {
    if (!activeRef.current) return
    const side = activeRef.current
    if (cancelZoneRef.current) {
      doCancel(side)
    } else {
      onPressEnd(side)
    }
    activeRef.current = null
    setInCancelZone(false)
    cancelZoneRef.current = false
  }, [onPressEnd, doCancel])

  // ===== Keyboard handlers (PC) =====
  useEffect(() => {
    if (isMobile) return

    const handleKeyDown = (e) => {
      if (e.repeat) return

      // Start speaking
      if (e.code === 'ShiftLeft' && !activeRef.current) {
        e.preventDefault()
        activeRef.current = 'left'
        onPressStart('left')
      } else if (e.code === 'ShiftRight' && !activeRef.current) {
        e.preventDefault()
        activeRef.current = 'right'
        onPressStart('right')
      }

      // Cancel keys: Z for left, Slash(?) for right
      if (e.code === 'KeyZ' && activeRef.current === 'left') {
        e.preventDefault()
        doCancel('left')
        // Don't clear activeRef — Shift is still held, user can keep speaking
      } else if ((e.code === 'Slash' || e.code === 'IntlRo') && activeRef.current === 'right') {
        e.preventDefault()
        doCancel('right')
      }
    }

    const handleKeyUp = (e) => {
      if (e.code === 'ShiftLeft' && activeRef.current === 'left') {
        onPressEnd('left')
        activeRef.current = null
      } else if (e.code === 'ShiftRight' && activeRef.current === 'right') {
        onPressEnd('right')
        activeRef.current = null
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [isMobile, onPressStart, onPressEnd, doCancel])

  // Global mouse/touch events
  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd])

  // Prevent context menu on long press
  const preventMenu = useCallback((e) => e.preventDefault(), [])

  const isListening = state === 'listening'
  const isLeftActive = activeButton === 'left' && (state === 'listening' || state === 'translating' || state === 'speaking')
  const isRightActive = activeButton === 'right' && (state === 'listening' || state === 'translating' || state === 'speaking')

  const getButtonStateClass = (isActive) => {
    if (!isActive) return ''
    if (state === 'listening') return 'dual-btn--listening'
    if (state === 'translating') return 'dual-btn--translating'
    if (state === 'speaking') return 'dual-btn--speaking'
    return ''
  }

  const getStatusText = () => {
    if (state === 'listening') return activeButton === 'left' ? '听取中...' : 'Listening...'
    if (state === 'translating') return '翻译中 / Translating...'
    if (state === 'speaking') return '播放中 / Speaking...'
    return ''
  }

  return (
    <div className="dual-voice">
      {/* Cancel zone - appears when dragging up during listening */}
      {isListening && (
        <div className={`cancel-zone ${inCancelZone ? 'cancel-zone--active' : ''}`}>
          <span className="cancel-zone__icon">{inCancelZone ? '✕' : '↑'}</span>
          <span className="cancel-zone__text">
            {inCancelZone ? '松手取消 / Release to cancel' : '上滑取消 / Drag up to cancel'}
          </span>
        </div>
      )}

      {/* Cancel flash overlay */}
      {showCancelled && (
        <div className="cancel-flash">已取消 / Cancelled</div>
      )}

      {/* Status text */}
      {state !== 'idle' && !showCancelled && (
        <div className="dual-voice__status">{getStatusText()}</div>
      )}

      {/* Interim text preview */}
      {isListening && interimText && !inCancelZone && (
        <div className={`dual-voice__interim ${showCancelled ? 'dual-voice__interim--cancelled' : ''}`}>
          {interimText}
        </div>
      )}

      {/* Buttons */}
      <div className="dual-voice__buttons">
        <button
          className={`dual-btn dual-btn--left ${isLeftActive ? getButtonStateClass(true) : ''} ${showCancelled && activeButton === 'left' ? 'dual-btn--cancel-flash' : ''}`}
          onMouseDown={handleMouseDown('left')}
          onTouchStart={handleTouchStart('left')}
          onContextMenu={preventMenu}
          disabled={state !== 'idle' && !isLeftActive}
        >
          <span className="dual-btn__icon">🎤</span>
          <span className="dual-btn__label">{leftLabel}</span>
          {!isMobile && <span className="dual-btn__hint">Left Shift · Z取消</span>}
        </button>
        <button
          className={`dual-btn dual-btn--right ${isRightActive ? getButtonStateClass(true) : ''} ${showCancelled && activeButton === 'right' ? 'dual-btn--cancel-flash' : ''}`}
          onMouseDown={handleMouseDown('right')}
          onTouchStart={handleTouchStart('right')}
          onContextMenu={preventMenu}
          disabled={state !== 'idle' && !isRightActive}
        >
          <span className="dual-btn__icon">🎤</span>
          <span className="dual-btn__label">{rightLabel}</span>
          {!isMobile && <span className="dual-btn__hint">Right Shift · ?取消</span>}
        </button>
      </div>

      {/* Bottom tip */}
      {state === 'idle' && (
        <div className="dual-voice__tip">
          {isMobile ? '按住说话 · 上滑取消' : '按住 Shift 说话 · Z/?取消 · 上滑取消'}
        </div>
      )}
    </div>
  )
}
