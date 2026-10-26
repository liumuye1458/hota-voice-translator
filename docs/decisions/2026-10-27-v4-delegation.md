---
id: DEC-2026-10-27-v4-delegation
title: v4.0 提速提准——CEO 全权委托技术选型
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-10-27
---

# v4.0 提速提准——CEO 全权委托

## Question
v3.0 上线后 CEO 反馈：翻译不准、反应变慢。要求认真调研最新技术与 GitHub 新项目，解决这两个痛点。

## Decision
CEO 原话要点："至于选什么模型你定，怎么改你也定，全是你定。反正产品功能和操作逻辑都是对的，不用改。"

据此：
- 技术方案、模型选择、实现方式由 Claude 决定，记录于 PRD-003、ADR-005，approved_by 标注为本委托。
- 边界：**不改功能、不改操作逻辑、不换 API Key/供应商**（换供应商会影响所有使用者）。
- 上线后由 CEO 真机试用验收；有问题按 PRD-003 §8 回滚。

## Consensus
- 调研三路：Web 调研、GitHub 项目调研、Codex 独立调研（Codex 无法读仓库，仅凭描述+官方文档）。三方一致：先优化级联（关推理、流式、领域 prompt、按住即识别），端到端语音翻译模型作为后续评测而不是本版替换。
- 关键数据全部用 CEO 的 Key 实测，见 PRD-003 §2。

## Action
- [x] PRD-003、ADR-005
- [x] 实现 + 测试（110/110）+ eval（PRD-003 §10）+ Codex 审查修复
- [x] 部署（tag `stable-v4.0`）
- [ ] CEO 真机试用（PRD-003 §6 最后一项）

## Related
- PRD-002 / DEC-2026-10-08-v3-scope-decision（被本版修正：Luna 保留但关推理）
