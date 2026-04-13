export default function StatusBar({ state, onOpenSettings }) {
  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <div className={`status-bar__dot status-bar__dot--${state}`} />
        <div>
          <div className="status-bar__title">HOTA Voice Translator</div>
          <div className="status-bar__subtitle">中文 ↔ Bahasa Indonesia</div>
        </div>
      </div>
      <button className="status-bar__gear" onClick={onOpenSettings}>
        ⚙
      </button>
    </div>
  )
}
