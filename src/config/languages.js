export const LANGUAGES = [
  { code: 'id-ID', name: 'Indonesia', nameZh: '印尼语', flag: '🇮🇩' },
  { code: 'vi-VN', name: 'Tiếng Việt', nameZh: '越南语', flag: '🇻🇳' },
  { code: 'en-US', name: 'English', nameZh: '英语', flag: '🇺🇸' },
  { code: 'th-TH', name: 'ไทย', nameZh: '泰语', flag: '🇹🇭' },
  { code: 'es-ES', name: 'Español', nameZh: '西班牙语', flag: '🇪🇸' },
  { code: 'ru-RU', name: 'Русский', nameZh: '俄语', flag: '🇷🇺' },
  { code: 'ar-SA', name: 'العربية', nameZh: '阿拉伯语', flag: '🇸🇦' }
]

// Left side is always Chinese
export const SOURCE_LANG = { code: 'zh-CN', name: '中文', flag: '🇨🇳' }

// Map speech recognition code to language name for translation prompt
export function getLangName(code) {
  if (code === 'zh-CN') return 'Chinese (Simplified)'
  const lang = LANGUAGES.find(l => l.code === code)
  return lang ? lang.name : 'Indonesian'
}

// Detect device type
export function isMobileDevice() {
  return (
    navigator.maxTouchPoints > 0 &&
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  )
}
