const CJK_REGEX = /[\u4e00-\u9fff]/

export function detectLanguage(text) {
  if (!text) return 'id'
  return CJK_REGEX.test(text) ? 'zh' : 'id'
}

export function langToSpeechLang(lang) {
  return lang === 'zh' ? 'zh-CN' : 'id-ID'
}
