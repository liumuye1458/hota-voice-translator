---
id: PRD-002
title: v3.0 Model Refresh — GPT-6 翻译 + 新 STT + TTS Provider 抽取
status: Draft (revised post Codex round-2)
author: Claude
approved_by:
approved_at:
---

# v3.0 Model Refresh

## 1. Problem 问题

### 1.1 技术过时
stable-v2.0 的模型选型基于 2026 年 4 月信息。2026 Q3-Q4 OpenAI 栈已经代际更新：
- **翻译**：GPT-6 系列（Astra/Luna/Sol）发布，Luna 定位"低成本高频"，价格比 `gpt-4o` 低 **25×**
- **STT**：OpenAI 官方 transcription guide 已把新集成的推荐模型从 `gpt-4o-transcribe` 换成 `gpt-transcribe`

### 1.2 TTS 死线（硬约束）
`gpt-4o-mini-tts` 在 **2027-01-06 停服**。替代者 `gpt-realtime-2.1-mini` 是 session-based 架构，**不走 `/v1/audio/speech`**。如果不提前解耦 TTS 调用，到时候需要紧急重写 audioEngine，risk 极高。

### 1.3 成本结构说明（修正：原稿表述有误导）
**翻译不是主成本**。当前 $0.175/天 里：
- TTS：$0.06/天（34%）
- STT：$0.025/天（14%）
- 翻译：$0.03/天（17%）
- 其他：$0.06/天

翻译降 25× 只能把总成本从 $0.175 → ~$0.14-$0.16（节省 10-20%）。**v3.0 的主要动机不是省钱，而是(a)为 TTS 死线铺路、(b)小幅质量提升、(c)避免技术栈继续漂移**。实施者不要被"GPT-6 便宜 25×"误导为预期大幅降本。

## 2. User 用户
不变：HOTA CEO (jimen) + 印尼籍员工。使用场景 50 轮对话/天。

## 3. Goals 目标

### Must
- [ ] 翻译模型切到 **`gpt-6-luna`**（主） + **`gpt-5.4-mini`**（粘性降级）
- [ ] 右路 STT 从 `gpt-4o-transcribe` 切到 `gpt-transcribe`
- [ ] **TTS Provider 抽取**：把 OpenAI HTTP TTS 调用从 audioEngine 剥离到独立 provider 类（见 [ADR-004](../adr/004-tts-provider-abstraction.md)），不改用户可感知行为
- [ ] 翻译模型可通过 Settings UI 切换；config 保留 `gpt-4o` 作为 legacy 回退选项
- [ ] STT 模型同上
- [ ] 39+ 单元测试全绿
- [ ] 20 条翻译金标准 **19/20 通过**（允许 1 case 模型切换轻微漂移）

### Should
- [ ] Settings 面板加 "翻译模型" / "STT 模型" 下拉
- [ ] 加 API Key 自检：Settings 中按钮 "检测可用模型"，调一次 Luna 和 Mini，显示绿/红
- [ ] 日用量监控（简单显示今日 token 消耗估算）

### Could
- [ ] 低置信翻译自动升级到 `gpt-6.1-sol`（质量兜底）—— 可选未来路径

## 4. Non-Goals 不做

- ❌ 架构重写（PWA + 无后端 + BYO Key 不变）
- ❌ `gpt-realtime-translate`（Realtime 全链路，仍需后端 token broker，CEO 已否决两次）
- ❌ Chrome Translator API / Gemini / Anthropic 作主栈
- ❌ **本次不实现 TTS stream 路径**（Realtime provider 到 2026-12 实际迁移时才做，避免现在"假装已设计好"）
- ❌ 立刻切 TTS 到 `gpt-realtime-2.1-mini`
- ❌ UX 改动（按钮、快捷键、WeChat 集成全部保留）

## 5. Solution 解决方案

### 5.1 Fallback 机制（HTTP 状态矩阵 + 粘性降级）

**错误分类表**：

| HTTP 状态 / 错误类型 | 行为 |
|------------------|------|
| `400` / `404` + 错误消息含 "model" | **粘性降级到 Mini**；本 page session 后续全部用 Mini；banner 告知 |
| `401` / `403` | **不 fallback**；提示用户 "API Key 无效或权限不足"（当前 showError 通路） |
| `429` (rate limit) + 消息含 "quota"/"tier" 关键字 | **粘性降级到 Mini**（可能是 Luna 模型 tier 不够） |
| `429` 一般 rate limit | 短 retry 一次（1s 后）；若再败，当次失败，不粘性降级 |
| `5xx` | 短 retry 一次；若再败，当次失败；**不粘性降级** |
| `TypeError` / abort / network timeout | 当次失败；**不粘性降级**（网络抖动不等于模型不可用） |

**粘性降级实现**：

- 内存状态 `translationModelDowngradedThisSession: boolean`
- 首次触发时：
  1. 显示 dismissible banner：**"当前 API Key 暂不支持 `gpt-6-luna`，已自动切到 `gpt-5.4-mini`。本页会继续使用 Mini，可在设置中重新检测。"**
  2. 发 structured console event：`console.info('translation_model_fallback', { from, to, reason, status })`
  3. 后续本 page session 所有翻译调用都直接走 Mini（不再先试 Luna）
- 重置时机：
  - 页面刷新（内存清零）
  - 设置里点击"重新检测模型可用性"按钮
  - 用户在 Settings 里手动改回 Luna

### 5.2 实施阶段（Day 0 是硬门禁）

**Day 0：Luna 可用性验证**（见 §7 Q1 checklist，**没完成不许开 implementation**）

**Day 1：翻译模型 + fallback**
- `services/openai.js` 的 `translateText` 加入 model 参数化 + 错误分类
- 实现粘性降级逻辑
- Settings 面板加"翻译模型"下拉 + 可用性检测按钮
- Eval 20 case，对比 v2 结果

**Day 1-2：STT 模型切换**
- `services/openai.js` 的 `transcribeAudio` model 字段参数化
- Settings 中加 STT 模型选择器
- 完成 §7 Q2 的 A/B 对比后才切默认值

**Day 2-3：TTS Provider 抽取**
- 新建 `src/core/ttsProvider.js`：接口定义 + `OpenAIStandardTTS` 实现（见 ADR-004）
- `src/core/audioEngine.js` 的 play 方法改为接受 provider 参数（不是 synthesizeSpeech 回调）
- **保留 audioEngine 现有 blob 播放逻辑**；不实现 stream 路径
- 单元测试：mock provider，验证 audioEngine 行为无变化

### 5.3 架构变化（修正：原稿与 ADR 冲突）

| 层 | v2.0 | v3.0 |
|----|------|------|
| 前端 | React 19 + Vite 7 PWA | 不变 |
| 部署 | GitHub Pages | 不变 |
| 后端 | 无 | 不变 |
| API Key | localStorage BYO | 不变 |
| 状态管理 | FSM + sessionId + attemptId | 不变 |
| audioEngine | 直接调用 synthesizeSpeech | **接受 TTSProvider 参数**；blob 播放逻辑不变；**不新增 stream 路径** |
| services/openai.js | 固定模型名 | 模型名参数化 + 错误分类 |

## 6. Acceptance Criteria 验收标准

- [ ] `npm test` 通过（≥39 case，TTSProvider 新加 mock 测试≥5 case）
- [ ] `npm run build` 成功
- [ ] 浏览器 dev server smoke test 零运行时错误
- [ ] 翻译金标准 20 case：**19/20 通过**
- [ ] STT A/B 测试（§7 Q2）完成，有量化结论
- [ ] **可观测性**：每轮对话 console 结构化日志：`{sessionId, model_translation, model_stt, tts_provider, latency_ms, fallback_triggered}` —— 替代主观的 "CEO 无 bug"
- [ ] CEO 实测 30+ 次对话，fallback_triggered 事件数 ≤ 预期（Luna 可用则 0；Luna 不可用则首次 1 后固定）
- [ ] Settings 中可切换翻译模型 + STT 模型并立即生效（刷新页面保留）
- [ ] 粘性降级 banner 显示正常，dismiss 后不重复

## 7. Open Questions 未决问题 + Blocking Checklist

### Q1：CEO 的 API Key 是否支持 GPT-6-luna？【BLOCKING — Day 0 必做】

**Pre-implementation checklist**（没全部完成，禁止开始 Day 1）：

- [ ] 用 CEO 的 OpenAI API Key 调用 `gpt-6-luna` 做最小 translation 请求（10 token in / 10 token out）
- [ ] 记录：HTTP status、error.code（如有）、error.message（如有）、request_id、实际 model 字段
- [ ] 如果 Luna 不可用：
  - PRD 的默认翻译模型立即改为 `gpt-5.4-mini`
  - Luna 保留为 Settings 可选项（但不作为默认，也不作为 fallback 源）
  - DEC-2026-10-08 更新为 "Luna 账户不支持，走 Mini 方案"
- [ ] 如果 Luna 可用：
  - 进入 Day 1 实施

**责任人**：Claude（提议）→ CEO（授权运行测试调用）

### Q2：`gpt-transcribe` vs `gpt-4o-transcribe` 的实际差异？【BLOCKING — Day 1 之后必做】

**最低测试标准**：

- [ ] 准备 **10-15 条测试音频**，覆盖：
  - 短句（<5s）× 3
  - 长句（15-30s）× 3
  - 带背景噪声 × 2
  - 含数字/金额 × 2
  - 含印尼人名/公司名 × 2
  - 中印尼混杂 × 2
- [ ] 两模型分别离线跑一遍
- [ ] 人工标注每条的"关键实体"（数字、人名、术语）
- [ ] 评价维度：关键实体识别正确率、整体可用性（主观 1-5 分）、延迟（ms）
- [ ] 决策规则：
  - 新模型在"关键实体正确率"上 **≥ 旧模型 95%**，可切默认
  - 否则：新模型保留为可选，默认仍 `gpt-4o-transcribe`

### Q3：TTS 抽象层的接口粒度？【已回答，见 ADR-004 修订版】

## 8. Risks 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| CEO 账户不支持 GPT-6 | 中 | 中 | Day 0 blocking checklist；自动降级 Mini |
| `gpt-6-luna` 对印尼语口语比 gpt-4o 差 | 低 | 中 | Eval 20 case + CEO 实测门禁 |
| `gpt-transcribe` 识别准确率下降 | 低 | 中 | §7 Q2 10-15 条标准测试；默认不切 |
| TTS Provider 抽取引入 regression | 中 | 高 | mock 测试 ≥5 case；blob 播放逻辑不动 |
| **feature flag / fallback 状态错乱** | 中 | 中 | Settings 手动 vs 自动降级 vs localStorage 持久化三者的优先级要明确；写 state machine 文档 |
| **TTS blob URL 内存泄漏** | 中 | 中 | provider 负责自己 revoke；sessionManager cleanup 时也强制 revoke |
| **Realtime 接口预测错误** | 高 | 低 | v3.0 不预测，只做 blob 契约；12 月实际迁移时再定 Realtime contract |
| **错误分类误判**（网络抖动当模型不可用） | 中 | 中 | §5.1 错误分类表严格区分；非 capability 类错误绝不触发粘性降级 |
| **API 兼容性漂移**（模型/定价/endpoint 行为变化） | 低 | 中 | Day 0 验证结果留档；每次模型切换前 ping 一次 |
| Codex round-2 发现新 BLOCKING | 中 | 低 | 本次已评审完，不再加轮 |

## 9. Rollback Plan 回退方案

分 4 层，按出现顺序越严重：

### 9.1 运行时回退（无需发布）
用户在 Settings 面板：
- 翻译模型下拉切回 `gpt-4o`
- STT 模型下拉切回 `gpt-4o-transcribe`
- TTS 模型保持（本次不改）
- 效果：行为立即恢复到 v2.0 等价，无需刷新

### 9.2 粘性降级（自动）
Luna 返回 capability 错误时，自动降级 Mini。见 §5.1。

### 9.3 发布回退（部署层）
重新部署 `stable-v2.0` git tag：
```
# 在 CI/部署环境执行（不是本地工作树）
# 1. 新建回退分支指向 v2.0 tag
git switch -c rollback-to-v2 stable-v2.0
# 2. 推送到 main（强制）
git push -f origin rollback-to-v2:main
# 3. GitHub Actions 自动重新部署
```
预计耗时 ~3 分钟（Actions 重跑）。

**不要**用 `git reset --hard` 在本地工作树上回退——这会破坏未提交工作，且不直接触发部署。

### 9.4 数据层回退
- localStorage 新增的 config key（`vt_translation_model`, `vt_stt_model`）都有默认值，用户不需要清缓存
- 用户历史对话 (`vt_messages`) schema 不变，v3 可读 v2 写的消息

### 9.5 操作手册
| 现象 | 执行人 | 操作 | 预期耗时 | 验证 |
|------|-------|------|---------|------|
| 翻译质量明显劣化 | CEO | Settings → 模型下拉切 `gpt-4o` | 10 秒 | 下一次翻译观察 |
| STT 识别严重出错 | CEO | Settings → STT 下拉切 `gpt-4o-transcribe` | 10 秒 | 下一次语音 |
| 多个 bug / 不稳定 | CEO 或 Claude | 发布回退（§9.3） | 3 分钟 | 访问线上页面确认 version 号 |

## 10. Related

- ADR-004（TTS Provider 抽象层 — 修订版）
- DEC-2026-10-08-v3-scope-decision（Q1/Q2/Q3 决定过程）
- 不动 PRD-001、ADR-001、ADR-002、ADR-003
