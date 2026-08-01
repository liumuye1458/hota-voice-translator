---
id: DEC-2026-06-29-selectable-message-text
title: 对话气泡文字支持选取复制 + 一键复制按钮
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-06-29
---

# 对话气泡文字支持选取复制 + 一键复制按钮

## Question
翻译气泡里的文字（原文 + 译文）无法用鼠标选中复制，用户想把翻译内容粘贴到微信/邮件/文档时用不了。

## Root Cause
`globals.css` 里给 `<body>` 设了全局 `user-select: none`（当初为防止移动端长按弹选择菜单）。规则太粗，把有价值内容也一起禁掉。

## Decision (Scope B — approved)
1. 给 `.message-bubble__original` 和 `.message-bubble__translation` 加 `user-select: text; cursor: text;` 覆盖全局
2. 在每条气泡右上角加**复制按钮** 📋，点击复制"原文\n译文"到剪贴板 + 显示"已复制"提示
3. 保留原有删除按钮 ✕（重新排布避免拥挤）

## Reasoning
- Scope A（只放开选取）在桌面完美，但移动端要长按体验差
- 直播场景在手机上使用概率不低 → 一键复制值 30 分钟额外投入
- 其他 UI 元素（按钮/状态栏/背景）继续保持 `user-select: none` 避免误选

## Action
- [x] 修改 `src/styles/globals.css` — 消息内容可选
- [x] 修改 `src/components/MessageBubble.jsx` — 加复制按钮 + toast
- [x] Smoke test（桌面拖选 + 点复制均生效）
- [x] Commit with `[DEC-2026-06-29-selectable-message-text]`

## Related
- Files: `src/styles/globals.css`, `src/components/MessageBubble.jsx`
- No PRD / ADR impact
