// Bumped on every meaningful release so user can verify they are on latest build
const APP_VERSION = 'v2.0.0-' + __BUILD_TIME__

export default function StatusBar({ state, onOpenSettings, onForceReset, targetLangLabel }) {
  const stuck = state !== 'idle'

  return (
    <div className="status-bar">
      <div className="status-bar__left">
        <div className={`status-bar__dot status-bar__dot--${state}`} />
        <div>
          <div className="status-bar__title">HOTA Voice Translator</div>
          <div className="status-bar__subtitle">
            中文 → <strong style={{ color: '#ff9933' }}>{targetLangLabel || '?'}</strong>
            <span style={{ opacity: 0.4, marginLeft: 8, fontSize: 10 }}>{APP_VERSION}</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          className="status-bar__gear"
          onClick={onForceReset}
          title="强制复位 / Force reset (Esc)"
          style={{
            color: stuck ? '#ff6b00' : 'rgba(239, 244, 248, 0.5)',
            fontSize: 18
          }}
        >
          ↺
        </button>
        <button className="status-bar__gear" onClick={onOpenSettings} title="设置 / Settings">
          ⚙
        </button>
      </div>
    </div>
  )
}
