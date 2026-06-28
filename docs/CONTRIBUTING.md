# 协作规范 / Contributing Rules

**Status**: Active
**Approved by**: jimen (CEO)
**Effective from**: 2026-06-29

---

## 为什么有这些规则

过去几周我们用"想到就改"的方式开发，结果是一坨屎——状态污染、bug 互相覆盖、决策无据可查。从今天起，**所有变更必须先沉淀成文档**。

这套规则同时约束 **CEO（jimen）** 和 **AI（Claude）**。

---

## 唯一铁律 / The One Rule

**没有对应文档，不动一行代码。**

文档可以是 PRD、ADR 或 Decision Log（取决于变更性质），但必须**先于代码存在**。

例外（B 级豁免）：纯文本修正（typo、注释拼写）、纯样式调整（颜色、间距），不涉及逻辑/行为变化。这类改动可以直接 commit，但 commit message 要标 `[chore]`。

---

## 文档类型

| 类型 | 用来回答 | 何时写 | 路径 |
|------|--------|--------|------|
| **PRD** | "我们要做什么功能？" | 新功能 / 现有功能大改 | `docs/prd/NNN-name.md` |
| **ADR** | "我们当年为什么这么做？" | 不可逆 / 影响深远的技术选择 | `docs/adr/NNN-name.md` |
| **Decision** | "上周聊到的那件事最后怎么定的？" | 任何对话产生的小决策 | `docs/decisions/YYYY-MM-DD-topic.md` |
| **Runbook** | "出事了怎么办？怎么部署？" | 第一次踩坑后立刻写 | `docs/runbook/topic.md` |

**判断指南**：
- 影响用户体验 → PRD
- 改变系统架构 / 选了一条不可逆的路 → ADR
- 聊天里聊出来的小决定 → Decision Log
- 操作流程 / 故障处理 → Runbook

不确定就写 Decision Log，写完事后再决定要不要升级。

---

## 工作流 / Workflow

```
jimen 提需求
    ↓
Claude 起草 PRD 或 Decision Log（依规模而定）
    ↓
jimen 审阅 → 通过 / 驳回 / 修改
    ↓
通过后才动代码
    ↓
commit message 必须引用文档 ID:
  [PRD-003] xxx
  [ADR-005] xxx
  [DEC-2026-06-29] xxx
  [chore] xxx       # 仅限 B 级豁免
    ↓
影响架构的 → Codex 评审一次
    ↓
所有测试通过 + Build 通过 + Smoke test 通过 → 合并 main
```

---

## 给 Claude 的铁律

1. **没文档不写代码**：CEO 给"快速改一下"的请求，Claude 必须先确认对应文档。哪怕 5 行小改，也要在 `docs/decisions/` 起一个 50 字日志，除非属于 B 级豁免。
2. **不脑补历史决策**：CEO 问"我们当时为什么这么做"，Claude 必须从 ADR/Decision Log 里查。找不到就说"没书面记录"，不能凭印象编。
3. **代码引用文档**：每个 commit message 包含 `[PRD-XXX] / [ADR-XXX] / [DEC-YYYY-MM-DD]`。无对应文档 → 不许 commit。
4. **拒绝 scope creep**：CEO 中途想加东西，Claude 必须停下来更新文档再继续。不接受"顺便加一下"。
5. **保留异议**：Claude 和 CEO 意见不一致时，记录在 ADR 的 "Alternatives considered"。不能因为 CEO 坚持就抹掉反对意见。
6. **不删除历史文档**：决策被推翻 → 新文档说明 supersedes，旧文档加 Status: Superseded。绝不删除。

---

## 给 jimen 的铁律

1. **想到的先沉淀**：脑子里冒出的需求，对 Claude 说之前**先用一段话写下来**——可以让 Claude 帮你转录，但要存盘。
2. **不要"再快速改一下"**：任何"我先试试看"的请求，必须先经过文档化流程。突发奇想改某个按钮颜色，那个改动也要进 Decision Log 或归入 B 级豁免。
3. **审过的文档不要轻易推翻**：可以否决，但要在新 Decision Log 里说明 why。让未来的你能追溯当时的判断。
4. **接受 Claude 可能说"不"**：你的需求和现有架构冲突，Claude 会 push back。你可以继续坚持，但必须更新 ADR 解释反方向的决定。
5. **重大决策留时间给 Codex 评审**：架构层面的事，预留半天到一天等 Codex 二次校验。

---

## 共同规则

1. **文档默认中文**，关键术语保留英文（"FSM"、"AbortController" 等不翻译）。
2. **每个文档必须有元数据头**：
   ```yaml
   ---
   id: PRD-003 / ADR-005 / DEC-2026-06-29
   title: ...
   status: Draft | Approved | Superseded by XXX
   author: Claude
   approved_by: jimen
   approved_at: 2026-06-29
   ---
   ```
3. **状态流转**：`Draft` → CEO 审阅 → `Approved` → 未来某天被替代 → `Superseded by XXX`。
4. **超过 30 天没动的 Draft 自动标为 Stale**，避免鬼项目堆积。

---

## 命名约定

| 类型 | 文件名格式 | 例子 |
|------|----------|------|
| PRD | `NNN-kebab-case.md` | `001-v2-rebuild.md` |
| ADR | `NNN-kebab-case.md` | `002-fsm-with-session-ids.md` |
| Decision Log | `YYYY-MM-DD-kebab-case.md` | `2026-06-29-default-translation-personality.md` |
| Runbook | `kebab-case.md`（无编号） | `deployment.md` |

**NNN** 是三位数序号，全局唯一不复用。即使某个 PRD 被废弃，编号也不回收。

---

## 模板

直接复制 `docs/_templates/` 下的对应文件。**别从头写**，模板里有必填项的提示。

---

## 何时升级规范本身

这份 CONTRIBUTING.md 也会演进。修改它需要：
1. 起一个 Decision Log，说明改什么、为什么
2. CEO 审批
3. 在本文件 "Effective from" 字段更新日期

---

**End of rules. 简单明了，越严越好。**
