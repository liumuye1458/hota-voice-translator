export default function StatusBar({ state, onOpenSettings }) {
  const handleTitleTap = () => {
    if (window.__debugTap) window.__debugTap()
  }

  return (
    <div className="status-bar">
      <div className="status-bar__left" onClick={handleTitleTap}>
        <div className={`status-bar__dot status-bar__dot--${state}`} />
        <div>
          <div className="status-bar__title">HOTA Voice Translator</div>
          <div className="status-bar__subtitle">中文 ↔ Multi-language · 三击标题开调试</div>
        </div>
      </div>
      <button className="status-bar__gear" onClick={onOpenSettings}>
        ⚙
      </button>
    </div>
  )
}
