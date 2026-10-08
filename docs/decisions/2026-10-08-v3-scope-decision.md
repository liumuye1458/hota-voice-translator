---
id: DEC-2026-10-08-v3-scope-decision
title: v3.0 scope 决议（Q1/Q2/Q3）
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-10-08
---

# v3.0 scope 决议

## Question
2026-10-08 CEO 提出 v3.0 技术栈刷新。Claude 和 Codex 分别独立调研后，发现 6 个月内 OpenAI 栈代际更新（GPT-6 系列、新 STT、TTS 停服死线）。Claude 整合两份调研后抛出三个决策问题。

## Decisions

### Q1：翻译模型 → A（激进路线）
- **主**：`gpt-6-luna`
- **兜底**：`gpt-5.4-mini`（Luna 不可用时自动降级）
- **Legacy**：`gpt-4o`（Settings 保留，用户可强制回退）

### Q2：STT → A（换）
- `gpt-4o-transcribe` → `gpt-transcribe`
- 旧模型 Settings 可切，保留 config fallback

### Q3：TTS 抽象层 → A（做）
- 加 TTSProvider 接口（详见 ADR-004）
- v3.0 不换实际 TTS 模型，只做架构重构
- 为 2027-01-06 `gpt-4o-mini-tts` 停服提前铺路

## Reasoning

### 对齐依据
- Agent 和 Codex 独立调研**全部主要结论一致**，分歧只在"翻译模型用 GPT-5.4 还是 GPT-6-luna"
- Codex 的 config 里默认模型是 `gpt-6.1-sol`（间接证据 GPT-6 系列确实存在，Agent 可能漏了关键词）
- CEO 判断：既然 Codex 对自己账户的模型都知道，可信度更高

### 为什么激进选 Luna
- 价格比 `gpt-5.4-mini` 便宜 **7-9×**
- OpenAI 官方把 Luna 定位为"低成本高频"场景，正好匹配我们"50 轮/天短对话"
- 账户支持性不确定，但有自动降级机制兜底

### 为什么 Q2/Q3 都选 A
- 两边调研一致推荐，无分歧
- 两处改动都有明确回退路径

## Action
- [x] 把三件事写入 PRD-002
- [x] TTS 抽象层单独写 ADR-004
- [ ] PRD-002 + ADR-004 送 Codex round-2 评审（约 $1-2 token 成本）
- [ ] 评审 approved 后开 `v3-rebuild` 分支动工
- [ ] 实施完成后合并到 main，tag `stable-v3.0`

## Related
- PRD-002（v3.0 Model Refresh）
- ADR-004（TTS Provider Abstraction）
