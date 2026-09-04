---
id: DEC-2026-09-04-message-replay-audio
title: 对话气泡加重播按钮
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-09-04
---

# 对话气泡加重播按钮

## Question
翻译播过一次就没了。CEO 想反复听 —— 听不清印尼语时、给员工示范正确读音时。

## Decision (Scope A — approved)
在每条对话气泡右上角加 🔊 **重播按钮**。点击重新走 TTS 播放译文。

## Reasoning
- 每次重播独立调 TTS API，不缓存（单次 ~$0.001 可忽略）
- 复用现有 `audioEngine.play` 路径，session 管理保持一致
- 不加"全局重播上一条"—— 现在气泡上就有按钮，多点一次不算负担；避免多入口带来的状态复杂度

## Implementation Notes
- `useTranslator` 新增 `replay(text)`：创建 session → 直接分片 → `audioEngine.play`，跳过 translate 阶段
- 触发 `sessionManager.create` 会自动取消当前正在播的（打断 = 用户直觉）
- 无 API Key / 网络错误 走现有 error banner 通路
- 播放中该按钮显示"停止"态；点击可中止
- 直播录音进行时禁用该按钮

## Action
- [x] `src/hooks/useTranslator.js` — 加 `replay(text, direction?)`
- [x] `src/components/MessageBubble.jsx` — 加 🔊 按钮 + 播放中样式
- [x] `src/components/ConversationView.jsx` — 转发 `onReplay`
- [x] `src/App.jsx` — 桥接 hook.replay
- [x] `src/styles/globals.css` — `.message-bubble__action--replay` 样式
- [x] Build + test 双绿
- [x] Commit with `[DEC-2026-09-04-message-replay-audio]`

## Related
- DEC-2026-06-29-selectable-message-text（同一按钮区域的布局）
- ADR-002（session 生命周期约束）
