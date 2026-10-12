---
id: DEC-2026-10-12-text-input-auto-direction
title: 文字输入框按内容自动判断翻译方向
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-10-12
---

# 文字输入框按内容自动判断翻译方向

## Question
CEO 常收到印尼语消息，想粘进本工具快速翻成中文（比通用 AI 工具快）。
但文字输入框写死 `zh→id`（`useTranslator.sendText`），粘贴印尼语会被当成中文"翻译"成印尼语，等于没翻。
只有按右键说印尼语才能走 `id→zh`。

## Decision (Q = A — approved)
1. **自动判断方向**：汉字占比 > 30% → `zh→id`（不变）；否则 → `id→zh`（目标语言 → 中文）。
   界面不加按钮，用法不变：粘贴 → 发送。
2. **外文 → 中文时不自动朗读**，只显示文字；需要听时点气泡上的 🔊（DEC-2026-09-04-message-replay-audio）。
3. 中文 → 外文保持原样：翻译后自动朗读。

## Reasoning
- 场景是"收到消息自己看"，自动朗读在办公室/开会时是打扰
- 30% 阈值与 `services/openai.js` 中译文语言自检的 `isChineseDominant` 一致
- 目标语言非印尼语（英语等）时同样成立：非中文 → 中文
- 中外混杂内容按占比判断；误判时用户改成纯文本重发即可（罕见，不值得加 UI）

## Implementation Notes
- 新增纯函数 `core/textDirection.js` → `detectTextDirection(text)`，带单测
- FSM 新增事件 `TEXT_DONE`：`translating → idle`，按 `translateAttemptId` 做过期过滤（不借用 `SPEAK_DONE`，后者校验 ttsQueueId）
- `sendText` 按检测结果建 session；`id→zh` 时 `onTranslationDone` 后 dispatch `TEXT_DONE`、记 `translator_turn`（outcome `ok-silent`）、dispose session
- 输入框 placeholder 改为提示可粘贴外文

## Action
- [x] `src/core/textDirection.js` + `__tests__/textDirection.test.js`
- [x] `src/core/translatorFSM.js` — `TEXT_DONE` + fsm 测试
- [x] `src/hooks/useTranslator.js` — `sendText` 自动方向 + 静默完成
- [x] `src/components/TextInputBar.jsx` — placeholder
- [x] Build + test 双绿
- [x] Commit with `[DEC-2026-10-12-text-input-auto-direction]`

## Related
- DEC-2026-09-04-message-replay-audio（静默结果靠 🔊 补听）
- ADR-002（session 生命周期、过期事件过滤）
