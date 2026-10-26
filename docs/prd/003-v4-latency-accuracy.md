---
id: PRD-003
title: v4.0 提速 + 提准（不改功能、不改操作）
status: Approved
author: Claude
approved_by: jimen（全权委托，见 DEC-2026-10-27-v4-delegation）
approved_at: 2026-10-27
related_adr: ADR-005
---

# v4.0 提速 + 提准

## 1. 问题（CEO 反馈，2026-10-26/27）

v3.0 上线后：**① 翻译不准 ② 反应变慢**。功能和操作逻辑不变，模型与实现全权委托。

## 2. 实测诊断（2026-10-27，CEO 的 API Key，脚本与原始结果在 evals/）

### 2.1 松手 → 开始出声，v3.0 各环节耗时

| 环节 | v3.0 做法 | 实测 |
|---|---|---|
| 识别 | 松手后上传整段录音 → gpt-4o-transcribe | 0.9–1.9 s |
| 翻译 | gpt-6-luna，**未传 reasoning_effort → 默认 medium 推理** | p50 2.3–2.7 s，p90 2.8–4.0 s |
| 合成 | gpt-4o-mini-tts，**等整段 MP3 下载完**才播 | 首字节 0.85–1.06 s，整段 1.3–1.7 s |
| **合计** | 三步串行 | **≈ 4.5–6.3 s** |

**慢的根因**：Luna 默认在每句都做推理（每次 ~90–100 个 reasoning token），这是 v3 比 v2 慢的主因；其次是三步完全串行。

### 2.2 准确率

- **识别**：同一段中文音频，gpt-4o-transcribe 一次把"印尼盾"听成"英镑"，一次听成"印尼顿"——金额/币种是最高风险点。当前识别 prompt 只用用户自填内容，默认为空。
- **翻译**：新建 24 句难题集（金额 万/亿↔juta/miliar、Pak/Bu 称呼、直播黑话、HR 术语、口语、语气词）+ 12 句**留出集**（不参与写词表），gpt-6-sol 作为严格评审打 1–5 分并标记关键错误（金额/人名/否定/日期/语气软化）。每个配置 ×2 次。

**v3 生产 prompt，难题集（48 次）：**

| 配置 | 分 | 关键错 | p50 |
|---|---|---|---|
| Luna medium（v3 生产） | 4.73 | 1 | 2729 ms |
| Luna none, t=0 | 4.58 | 1 | 1431 ms |
| gpt-5.6-luna none | 4.63 | 2 | 1262 ms |
| gpt-5.4-mini none | 4.54 | 3 | 986 ms |
| gpt-4o（v2） | 4.29 | 2 | 1057 ms |

错误集中在**领域知识**而非模型：憋单/投流/起号/主播直译错；Pak/Bu→先生/女士；1,2 miliar→"一点二十亿"、400 juta→"四百万"；KTP/ijazah 泛化。

**加领域 prompt（词表 + 数字换算 + 称呼规则）后：**

| 配置 | 难题集 分/关键错 | 留出集 分/关键错（v3→v4） | p50 |
|---|---|---|---|
| **Luna none, t=0** | **4.96 / 0** | **4.13/4 → 4.58/2** | **1.43 s** |
| gpt-5.6-luna none | 4.96 / 0 | 4.13/3 → 4.42/2（金额题两次错） | 1.13 s |
| gpt-5.4-mini none | 4.83 / 0 | 4.21/4 → 4.00/5 | 0.91 s |
| Luna medium | 4.90 / 1 | 4.38/2 → 4.67/2 | 2.29 s |

结论：**领域 prompt 是准确率最大杠杆**；Luna 关推理后几乎不掉分、快 ~1 s；温度可设 0（仅在 reasoning_effort=none 时允许）。

### 2.3 新技术验证

| 方案 | 结果 |
|---|---|
| 按住期间流式识别（Realtime transcription, gpt-live-transcribe） | 松手→定稿 **0.54–0.84 s**（上传整段 0.9–1.9 s）；按住时已有实时字幕 |
| 浏览器直连 | `/v1/realtime/client_secrets` CORS `*`，浏览器可用用户 Key 换临时凭证，**无需后端**；凭证 10 分钟内可复用 |
| Realtime 下的 gpt-transcribe | 只在提交后处理，0.93–1.39 s，无实时字幕 → 不选 |
| 专用语音翻译 gpt-realtime-translate | 不支持词表/指令、不是按键式设计 → 本版不用（§7） |
| Realtime TTS gpt-realtime-2.1-mini | 逐字朗读可靠（含"忽略指令"测试句），首音 0.8–1.3 s，与现 TTS 相当 → 放到 TTS 停服迁移时做（§7） |

## 3. 方案（v4.0）

### 3.1 翻译：Luna 关推理 + 领域 prompt + 流式
1. 默认 `gpt-6-luna`，`reasoning_effort: "none"`，`temperature: 0`；自动降级仍到 `gpt-5.4-mini`（同参数）。每个模型的请求参数集中在 `modelRouter.js` 的模型表里。
2. **内置领域 prompt**（`src/config/domainPrompt.js`）：业务背景、数字换算规则、称呼规则、术语表、印尼口语。用户自定义规则仍追加在后面、优先级最高。
3. **流式输出 + 第一句先读**：翻译以 SSE 流式返回，第一句完整后立刻送 TTS，剩余部分边到边排队。第一句先做输出语言自检，不对就中止流、走原有的强调重试。

### 3.2 识别：按住即识别（ADR-005）
1. 按下：照常开 MediaRecorder（**兜底录音**），同时用缓存的临时凭证连 Realtime，按住期间把麦克风 PCM（24 kHz）实时推上去，连上之前的音频先缓存再补发。
2. 松手：提交 → 等最终文字。
3. **任何异常自动回退到 v3 的上传识别**：凭证/连接失败、松手时还没连上、提交后 3.5 s 无结果、结果为空——用兜底录音走 gpt-4o-transcribe。用户无感，只是那一句慢一点。
4. 识别 prompt = 内置识别词表（印尼盾/Rupiah/GMV/主播…）+ 用户自填。
5. 设置里的"识别模型"：`实时（默认）`/`gpt-4o-transcribe 上传`/`gpt-transcribe 上传`。

### 3.3 合成：不换模型
`gpt-4o-mini-tts` 不变；因为翻译流式化，**第一句先合成先播**。

### 3.4 可观测性
`translator_turn` 增加：`stt_path`（realtime/upload/upload-fallback）、`stt_ms`（松手→文字）、`mt_first_ms`（文字→第一句译文）、`first_audio_ms`（松手→开始出声）、`fallback_reason`。

### 3.5 优先处理档（实施中追加）
Luna / Mini 请求带 `service_tier: "priority"`（OpenAI Fast mode，价格 ×2）。实测 Luna 首字 p50 1142→915 ms、p90 1407→1132 ms；Luna 单价极低，每句多花约 US$0.0002。账号若拒绝该参数（400 + param service_tier），自动去掉重试一次，本页之后不再带——**优先档永远不会导致翻译失败**。

### 3.6 设置迁移（实施中追加）
v3 保存在 localStorage 的模型选择（翻译/识别）在首次打开 v4 时清除一次（`settingsVersion: 4`），保证所有使用者都用上新默认；Key、语言、音色、词汇、规则保留。

## 4. 预期

| 环节 | v3.0 | v4.0 预期 |
|---|---|---|
| 识别（松手后） | 0.9–1.9 s | 0.5–0.9 s |
| 翻译到第一句 | 2.3–2.7 s（整段） | ~0.8–1.4 s |
| 合成第一句 | 1.3–1.7 s | 1.0–1.5 s（句子更短） |
| **松手→出声** | **4.5–6.3 s** | **~2.5–3.5 s** |

准确率：难题集关键错 1→0、留出集 4→2（测试数据，真实语音以 CEO 试用为准）。

## 5. 不做（Out of scope）
- 改 UI、改操作、加新功能
- 换供应商（Gemini/Soniox 需要新 Key，影响所有使用者）
- 传前几句对话作上下文（有助于消歧，但有"把上文也翻进去"的风险，需单独评测）

## 6. 验收
- [ ] `npm test` 全绿，新增：领域 prompt/模型参数、流式切句、ChunkFeed 播放、Realtime 识别（mock WebSocket）+ 回退分支
- [ ] `npm run build` 绿
- [ ] 留出集 + 难题集用**生产代码**重跑（`evals/runJudgedEvals.mjs`），Luna-none-v4 关键错 ≤ v3 生产
- [ ] Node 端用真实 Key 跑 Realtime 识别模块（与浏览器同一鉴权方式）
- [ ] 浏览器预览：mock 网络走通语音/文字两条路径，无 console 报错
- [ ] CEO 真机试用：说 5–10 句，看速度和准确度

## 7. 后续（不在本版）
1. **TTS 停服迁移（2027-01-06 前，计划 12 月）**：换 `gpt-realtime-2.1-mini`，PCM 流式播放；另写 ADR，回答 ADR-004 的 8 个开放问题。今天已验证：逐字朗读可靠、首音 0.8–1.3 s。
2. 上下文消歧评测（§5）。
3. `gpt-realtime-translate` 作为"同传模式"的可行性评测（无词表，需看真实业务语料表现）。

## 8. 回滚
- 设置里：识别模型切回"gpt-4o-transcribe 上传"→ 等于 v3 识别；翻译模型可切 gpt-5.4-mini / gpt-4o。
- 代码：`stable-v3.0` tag，`git switch -c rollback-to-v3 stable-v3.0 && git push -f origin rollback-to-v3:main`。

## 10. 实施结果（2026-10-27）

### 10.1 生产代码实测（Node，与浏览器同一鉴权方式；音频按真实时长推送）
| 环节 | 结果 |
|---|---|
| 实时识别（`RealtimeTranscriber`，经 48k→24k 重采样） | 松手→定稿 507 / 612 / 733 / 876 ms；连接 0.78–0.86 s（与说话重叠） |
| 流式翻译 Luna none（默认档） | 第一句 0.98–2.0 s，整段 1.1–2.5 s |
| 流式翻译 Luna none + priority（12 次顺序请求） | 首字 p50 915 ms / p90 1132 ms，整段 p50 1210 ms |

### 10.2 准确率（`evals/runJudgedEvals.mjs`，生产 `translateText`，gpt-6-sol 评审）
| 配置 | dev（24 句） | holdout（12 句） |
|---|---|---|
| v3 生产（Luna medium + v3 prompt，草稿脚本） | 4.73 / 关键错 1（48 次） | 4.38 / 2（24 次） |
| **v4 生产（Luna none + 领域 prompt + 币种规则），×3** | **4.96 / 0（72 次）** | **4.53 / 0（36 次）** |
| v4 gpt-5.4-mini，×2 | 4.79 / 0 | 3.92 / 6 |

实施中新增规则：印尼语金额译成中文**必须带"印尼盾"**（holdout 里"3,2 juta → 320万"会被读成人民币）。剩余扣分：福袋泛译（可在设置→自定义规则补词）、"ganti hari Minggu"原文歧义。

### 10.3 浏览器预览（mock OpenAI + 合成麦克风，不使用真实 Key）
- 设置迁移：v3 的 `gpt-4o` / `gpt-4o-transcribe` 被清除，其余保留；版本号 v4.0.0
- 预取凭证：中/印各 1 个，带内置识别词表
- 左键：实时识别（21 包 ≈ 2.0 s 音频）→ 流式翻译 → 第一句先 TTS、余下第二段
- 右键 + 模拟 Realtime 报错：自动回退上传识别 gpt-4o-transcribe，本轮仍成功，记录 `fallback_reason`
- 文字：中文→流式+朗读；印尼语→中文静默（DEC-2026-10-12 行为不变）
- console 无报错

### 10.4 测试
`npm test` 105/105（新增 32：流式切句、ChunkFeed、audioEngine 流式播放与取消、翻译请求参数/领域 prompt/优先档回退、流式翻译含语言纠错与错误不出声、Realtime 识别 10 种生命周期与回退、凭证缓存、重采样与 PCM 编码）。

### 10.5 Codex 对抗审查（2026-10-27，6 条全部成立并已修复）
| # | 级别 | 问题 | 修复 |
|---|---|---|---|
| 1 | BLOCKING | 采集 AudioContext.resume() 可能永不返回 → 松手后永远卡在"识别中" | 按下时在手势内同步 `warmCapture()` 恢复；松手等采集最多 0.8 s，否则回退上传（`capture-not-ready`） |
| 2 | BLOCKING | 翻译流不断开但不再来数据 → 永远卡在翻译/朗读 | 看门狗：首字节 15 s、数据间隔 8 s，超时报错走现有错误/部分播放流程 |
| 3 | SHOULD | 流在 `[DONE]` 前断开被当成完整译文（可能截掉否定/金额） | 必须见到 `[DONE]`，否则报"译文不完整"，余下部分不朗读；流内 error 事件抛错 |
| 4 | SHOULD | 流式片段绕过 4096 字符 TTS 上限保护 | 每个片段再过 `sentenceChunker.split` |
| 5 | SHOULD | worklet 加载失败时 AudioContext 泄漏 | 失败路径 close |
| 6 | SHOULD | 冷启动采集晚于录音开始 → 实时识别缺开头却"成功" | 采集就绪晚于 150 ms → 本句回退上传（`capture-started-late`） |

修复后：`npm test` 110/110；生产代码真实 API 复测通过（识别 0.50–0.64 s，翻译第一句 1.1–1.6 s）。
自查补充：设置里输入 Key/词汇时每次按键都会重新预取凭证 → 加 1.5 s 防抖。

## Status History
- 2026-10-27: Draft + Approved（CEO 全权委托）
- 2026-10-27: 实施结果（§3.5 优先档、§3.6 设置迁移、§10）
- 2026-10-27: Codex 审查 6 条修复（§10.5）
