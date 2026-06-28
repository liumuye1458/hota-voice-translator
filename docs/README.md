# Documentation Index

这是 HOTA Voice Translator 的所有产品/技术文档。**任何对系统的变更都从这里开始**。

新来的同事 / 未来的 AI 助手 / 三个月后的你自己：**先读 [CONTRIBUTING.md](CONTRIBUTING.md)**。

---

## 目录

### 📋 [CONTRIBUTING.md](CONTRIBUTING.md)
协作规范——所有人必须遵守。**改代码之前先读这个**。

### 📝 [prd/](prd/) — Product Requirements Documents
产品要做什么。

| ID | 标题 | 状态 |
|----|------|------|
| [PRD-001](prd/001-v2-rebuild.md) | v2.0 完全重构 | Approved |

### 🏛️ [adr/](adr/) — Architecture Decision Records
为什么这样做。不可逆的技术选择记录。

| ID | 标题 | 状态 |
|----|------|------|
| [ADR-001](adr/001-no-backend.md) | 不引入后端 | Approved |
| [ADR-002](adr/002-fsm-with-session-ids.md) | FSM + sessionId + attemptId 架构 | Approved |
| [ADR-003](adr/003-tts-mp3-not-mediasource.md) | TTS 用 MP3 + 持久 Audio 元素，不用 MediaSource | Approved |

### 📒 [decisions/](decisions/) — Decision Logs
聊天里聊出来的小决定。按日期归档。

| 日期 | 主题 | 状态 |
|------|------|------|
| [2026-06-29](decisions/2026-06-29-default-translation-personality.md) | CEO 默认翻译人设配置 | Approved |

### 🛠️ [runbook/](runbook/) — Operational Runbooks
出事了怎么办。当前为空——第一次部署事故后填写。

### 🧩 [_templates/](_templates/)
新建文档复制这里的模板。**别从头写**。

---

## 快速查找

**我想加新功能？** → 起 PRD（复制 `_templates/prd.md`）
**我想改架构？** → 起 ADR（复制 `_templates/adr.md`）
**我想记一个小决定？** → 起 Decision Log（复制 `_templates/decision.md`）
**我想知道某个东西当初为什么这么做？** → 翻 adr/ 或 decisions/
**我想部署 / 出 bug 救火？** → runbook/（如果还没写就一边救火一边写）
