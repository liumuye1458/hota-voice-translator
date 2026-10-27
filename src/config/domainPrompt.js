// src/config/domainPrompt.js — PRD-003 §3.1 / §3.2
//
// Built-in business knowledge for HOTA (Indonesian live-streaming company).
// The golden eval (evals/translation-hard.json + holdout) showed most
// mistranslations were domain errors — jargon, Pak/Bu, 万/亿 ↔ juta/miliar —
// not model errors. Appended to every translation system prompt; the user's
// own rules from Settings still come after it with highest priority.

export const DOMAIN_PROMPT = `Context: workplace talk at an Indonesian live-streaming (e-commerce live selling) company, between Chinese management and Indonesian staff.

Numbers (check every number twice):
- 万 = 10.000, 亿 = 100.000.000. ribu = 千, juta = 百万, miliar = 十亿.
- Examples: 50万 = 500 ribu; 8500万 = 85 juta; 1.2亿 = 120 juta; 12亿 = 1,2 miliar; 400 juta = 4亿; 750 ribu = 75万.
- 印尼盾 = Rupiah. Keep %, dates, times, quantities exact. Do not invent weekdays or dates.
- Money in Indonesian speech is Rupiah. When translating into Chinese, always write the currency: "3,2 juta" → "320万印尼盾" (a bare 320万 reads as RMB).

Address terms:
- Pak / Bapak / Bos → 老板 (or 领导 when clearly a manager); Bu / Ibu → 姐 (or 老板 if she is the boss); Kak → 亲 (customer) / 姐/哥 (colleague); Mas → 哥; Mbak → 姐. Never 先生/女士.
- Keep personal names as written (Rina, Dewi, 小雅 → Xiaoya).

Glossary (zh ↔ id):
主播 = host live; 开播/直播 = live; 场观 = jumlah penonton; 转化率 = conversion rate; 憋单 = menahan order (sengaja menunda buka order); 投流 = iklan berbayar / ads; 坑位费 = slot fee; 起号 = membangun akun baru; 带货 = jualan live; 人设 = persona; GMV = GMV; 退货率 = return rate; 提成 = komisi; 底薪 = gaji pokok; 加班 = lembur; 请假 = izin; 迟到 = telat/terlambat; 扣钱 = potong gaji; 开除 = pecat; 身份证 = KTP; 学历证明 = ijazah; 社保 = BPJS; 年终奖/开斋节奖金 = THR; 运费 = ongkir; 现货 = ready stock; 卡顿 = ngelag; 合同 = kontrak; HR = HRD.
- Indonesian slang: gak/nggak = tidak; udah = sudah; banget = 很; doang = 只; wkwk = 哈哈; siap = 收到/好的; kabarin = 通知/汇报; lowbat = 没电.`

// Recognition hints (STT `prompt`). Kept short: long prompts can bias
// recognition toward words that weren't said.
const STT_TERMS = {
  zh: '印尼盾，GMV，主播，开播，场观，转化率，憋单，投流，坑位费，起号，带货，提成，底薪，加班，请假，THR，BPJS，KTP。',
  id: 'Rupiah, juta, ribu, miliar, GMV, host, live, shift, lembur, izin, gaji pokok, komisi, THR, BPJS, KTP, HRD, ongkir, ready stock.'
}

/**
 * STT prompt = built-in terms for the spoken language + the user's own vocabulary.
 * @param {string} lang ISO 639-1 ('zh', 'id', ...)
 * @param {string} userPrompt Settings → STT Vocabulary
 */
export function buildSttPrompt(lang, userPrompt = '') {
  const parts = [STT_TERMS[lang], (userPrompt || '').trim()].filter(Boolean)
  return parts.join('\n')
}
