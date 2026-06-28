---
id: ADR-001
title: 不引入后端，保持纯 PWA + 用户自带 API Key
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-06-29
related_prd: PRD-001
---

# 不引入后端，保持纯 PWA + 用户自带 API Key

## Context

HOTA Voice Translator 是 CEO 内部使用的翻译工具，**不是面向公众的 SaaS**。OpenAI 官方文档强烈建议浏览器端不要暴露 API Key，应该有一个后端 token broker 发放 ephemeral keys。Codex 在 v2.0 评审时也将此列为 BLOCKING 项之一。

但引入后端意味着：
- 需要运维一个长期运行的服务（VPS / Cloudflare Worker / Vercel Function）
- 需要监控、计费、密钥轮换
- 增加部署复杂度

## Decision

**v2.0 不引入后端。继续用 localStorage 存储用户自带的 OpenAI API Key。**

## Alternatives Considered

### 方案 A：引入 Cloudflare Worker 做 token broker
- **优点**: 符合 OpenAI 最佳实践；可加 spend cap、调用频率限制；多设备无缝
- **缺点**: 增加一个待维护的服务；额外的 Worker 成本（虽然免费额度内）；架构复杂度上升一档
- **没选**: 当前规模（CEO 一人 + 印尼员工 < 10 人）不足以摊销维护成本

### 方案 B：本地代理（用户自部署 cloudflared）
- **优点**: 用户控制全链路
- **缺点**: 印尼员工肯定不会自己部署 cloudflared
- **没选**: UX 不可接受

### 方案 C（采纳）：纯前端 + localStorage + 教育用户在 OpenAI 后台设月度上限
- **优点**: 零后端，零运维，部署到 GitHub Pages 即可
- **缺点**: API Key 暴露给浏览器扩展、XSS、共享 PC、屏幕截图
- **选了它**: CEO 明确认可风险，因为是内部工具不是公开 SaaS

## Consequences

### Positive
- 部署仅需 git push（GitHub Actions auto-deploy）
- 零运维成本
- 单一仓库即完整产品

### Negative
- API Key 安全责任落在用户身上
- 无法做调用频率限制（用户必须在 OpenAI 后台设月度上限）
- 未来要接 `gpt-realtime-translate`（需要 WebSocket + ephemeral token）时必须引入后端

### Neutral
- 多设备同步需要用户手动复制设置（已加 "重置所有数据" 应急按钮）

## Mitigation

- 设置面板里加显眼提示：「请在 OpenAI 后台为这个 key 设置月度上限 $20」
- README / 用户说明里强调：「不要在共享 PC 上使用」

## Status History
- 2026-06-29: Approved（沉淀自 v2.0 重构期间 Codex 评审的反对意见）
