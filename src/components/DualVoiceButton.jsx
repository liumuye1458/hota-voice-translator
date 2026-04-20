import { useRef, useCallback, useEffect, useState } from 'react'

const CANCEL_DRAG_THRESHOLD = 60

export default function DualVoiceButton({
  leftLabel,
  rightLabel,
  activeButton,
  state,
  isMobile,
  interimText,
  hasInputText,
  onPressStart,
  onPressEnd,
  onCancel,
  onSendText
}) {
  const activeRef = useRef(null)
  const startPosRef = useRef({ x: 0, y: 0 })
  const [inCancelZone, setInCancelZone] = useState(false)
  const [showCancelled, setShowCancelled] = useState(false)
  const cancelZoneRef = useRef(false)
  // Track Left Shift "tap-to-send" mode: armed when shift pressed with input text
  const leftShiftArmedRef = useRef(false)
  const leftShiftOtherKeyRef = useRef(false)
  // Mirror hasInputText in a ref so keydown handler sees the latest value
  const hasInputTextRef = useRef(hasInputText)
  useEffect(() => { hasInputTextRef.current = hasInputText }, [hasInputText])

  const triggerCancelFlash = useCallback(() => {
    setShowCancelled(true)
    setTimeout(() => setShowCancelled(false), 600)
  }, [])

  const doCancel = useCallback((side) => {
    triggerCancelFlash()
    onCancel(side)
  }, [onCancel, triggerCancelFlash])

  // ===== Pointer handlers (unified mouse + touch) =====
  const handlePointerDown = useCallback((side) => (e) => {
    // Only handle primary button (left click / touch)
    if (e.pointerType === 'mouse' && e.button !== 0) return
    activeRef.current = side
    startPosRef.current = { x: e.clientX, y: e.clientY }
    setInCancelZone(false)
    cancelZoneRef.current = false
    onPressStart(side)
  }, [onPressStart])

  const handlePointerMove = useCallback((e) => {
    if (!activeRef.current) return
    const dy = startPosRef.current.y - e.clientY
    const inZone = dy > CANCEL_DRAG_THRESHOLD
    if (inZone !== cancelZoneRef.current) {
      cancelZoneRef.current = inZone
      setInCancelZone(inZone)
    }
  }, [])

  const handlePointerUp = useCallback(() => {
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

  // Global pointer events
  useEffect(() => {
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  // ===== Keyboard handlers (PC: Shift keys) =====
  useEffect(() => {
    if (isMobile) return

    const isLeftShift = (e) => e.code === 'ShiftLeft' || (e.key === 'Shift' && e.location === 1)
    const isRightShift = (e) => e.code === 'ShiftRight' || (e.key === 'Shift' && e.location === 2)
    const isCancelLeft = (e) => e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z'
    const isCancelRight = (e) => e.code === 'Slash' || e.key === '/' || e.key === '?'

    const handleKeyDown = (e) => {
      if (e.repeat) return

      if (isLeftShift(e) && !activeRef.current && !leftShiftArmedRef.current) {
        // If the input box has text, arm "tap to send" instead of starting voice
        if (hasInputTextRef.current) {
          leftShiftArmedRef.current = true
          leftShiftOtherKeyRef.current = false
          // DO NOT preventDefault — let Shift still work for capitalization
          return
        }
        e.preventDefault()
        activeRef.current = 'left'
        onPressStart('left')
        return
      }

      if (isRightShift(e) && !activeRef.current) {
        e.preventDefault()
        activeRef.current = 'right'
        onPressStart('right')
      }

      // If armed and user presses any other key, treat as Shift-combo (e.g. Shift+A)
      // and disarm — we won't send on release
      if (leftShiftArmedRef.current && !isLeftShift(e)) {
        leftShiftOtherKeyRef.current = true
      }

      // Cancel keys
      if (isCancelLeft(e) && activeRef.current === 'left') {
        e.preventDefault()
        doCancel('left')
      } else if (isCancelRight(e) && activeRef.current === 'right') {
        e.preventDefault()
        doCancel('right')
      }
    }

    const handleKeyUp = (e) => {
      if (isLeftShift(e)) {
        // Tap-to-send path: armed with no other key pressed = pure tap
        if (leftShiftArmedRef.current) {
          const wasPureTap = !leftShiftOtherKeyRef.current
          leftShiftArmedRef.current = false
          leftShiftOtherKeyRef.current = false
          if (wasPureTap && hasInputTextRef.current) {
            onSendText?.()
          }
          return
        }
        // Voice path (original behavior)
        if (activeRef.current === 'left') {
          onPressEnd('left')
          activeRef.current = null
        }
      } else if (isRightShift(e) && activeRef.current === 'right') {
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
  }, [isMobile, onPressStart, onPressEnd, doCancel, onSendText])

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
      {isListening && (
        <div className={`cancel-zone ${inCancelZone ? 'cancel-zone--active' : ''}`}>
          <span className="cancel-zone__icon">{inCancelZone ? '✕' : '↑'}</span>
          <span className="cancel-zone__text">
            {inCancelZone ? '松手取消 / Release to cancel' : '上滑取消 / Drag up to cancel'}
          </span>
        </div>
      )}

      {showCancelled && (
        <div className="cancel-flash">已取消 / Cancelled</div>
      )}

      {state !== 'idle' && !showCancelled && (
        <div className="dual-voice__status">{getStatusText()}</div>
      )}

      {isListening && interimText && !inCancelZone && (
        <div className={`dual-voice__interim ${showCancelled ? 'dual-voice__interim--cancelled' : ''}`}>
          {interimText}
        </div>
      )}

      <div className="dual-voice__buttons">
        <button
          className={`dual-btn dual-btn--left ${isLeftActive ? getButtonStateClass(true) : ''} ${showCancelled && activeButton === 'left' ? 'dual-btn--cancel-flash' : ''}`}
          onPointerDown={handlePointerDown('left')}
          onContextMenu={preventMenu}
          style={{ touchAction: 'none' }}
          disabled={state !== 'idle' && !isLeftActive}
        >
          <span className="dual-btn__icon">🎤</span>
          <span className="dual-btn__label">{leftLabel}</span>
          {!isMobile && <span className="dual-btn__hint">按住左Shift说话 · 敲Shift发送文本</span>}
        </button>
        <button
          className={`dual-btn dual-btn--right ${isRightActive ? getButtonStateClass(true) : ''} ${showCancelled && activeButton === 'right' ? 'dual-btn--cancel-flash' : ''}`}
          onPointerDown={handlePointerDown('right')}
          onContextMenu={preventMenu}
          style={{ touchAction: 'none' }}
          disabled={state !== 'idle' && !isRightActive}
        >
          <span className="dual-btn__icon">🎤</span>
          <span className="dual-btn__label">{rightLabel}</span>
          {!isMobile && <span className="dual-btn__hint">Right Shift · ?取消</span>}
        </button>
      </div>

      {state === 'idle' && (
        <div className="dual-voice__tip">
          {isMobile ? '按住说话 · 上滑取消' : '按住 Shift 说话 · Z/?取消 · 上滑取消'}
        </div>
      )}
    </div>
  )
}
