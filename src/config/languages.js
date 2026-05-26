// `name`     — short native script for the button label
// `nameZh`   — Chinese display name
// `promptName` — UNAMBIGUOUS LANGUAGE name for the GPT translation prompt.
//               Must be the LANGUAGE name (e.g. "Indonesian"), never the
//               country name (e.g. "Indonesia"), to prevent GPT confusion.
export const LANGUAGES = [
  { code: 'id-ID', name: 'Indonesia',  nameZh: '印尼语',  flag: '🇮🇩', promptName: 'Indonesian (Bahasa Indonesia)' },
  { code: 'vi-VN', name: 'Tiếng Việt', nameZh: '越南语',  flag: '🇻🇳', promptName: 'Vietnamese (Tiếng Việt)' },
  { code: 'en-US', name: 'English',    nameZh: '英语',    flag: '🇺🇸', promptName: 'English' },
  { code: 'th-TH', name: 'ไทย',         nameZh: '泰语',    flag: '🇹🇭', promptName: 'Thai (ภาษาไทย)' },
  { code: 'es-ES', name: 'Español',    nameZh: '西班牙语', flag: '🇪🇸', promptName: 'Spanish (Español)' },
  { code: 'ru-RU', name: 'Русский',    nameZh: '俄语',    flag: '🇷🇺', promptName: 'Russian (Русский)' },
  { code: 'ar-SA', name: 'العربية',     nameZh: '阿拉伯语', flag: '🇸🇦', promptName: 'Arabic (العربية)' }
]

// Left side is always Chinese
export const SOURCE_LANG = { code: 'zh-CN', name: '中文', flag: '🇨🇳', promptName: 'Chinese (Simplified, 简体中文)' }

// Returns the UNAMBIGUOUS language name to feed into the GPT prompt.
// Always returns a language name, never a country name.
export function getLangName(code) {
  if (code === 'zh-CN' || code === 'zh') return SOURCE_LANG.promptName
  const lang = LANGUAGES.find(l => l.code === code)
  return lang ? lang.promptName : 'Indonesian (Bahasa Indonesia)'
}

// Detect device type
export function isMobileDevice() {
  return (
    navigator.maxTouchPoints > 0 &&
    /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
  )
}
