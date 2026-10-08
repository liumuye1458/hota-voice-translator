---
id: ADR-004
title: TTS Provider 抽取（blob 契约，为 Jan 2027 迁移隔离调用边界）
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-10-08
related_prd: PRD-002
---

# TTS Provider 抽取

## Context 背景

OpenAI 宣布 **`gpt-4o-mini-tts` 在 2027-01-06 停服**。替代者 `gpt-realtime-2.1-mini` 是 session-based（WebSocket/WebRTC），不走 `/v1/audio/speech`，不返回 MP3。

当前 `audioEngine.play()` 直接接收 `synthesizeSpeech` 回调（`services/openai.js`），HTTP TTS 细节渗透进播放引擎。到 12 月迁移时，改动面会同时覆盖 services 和 audioEngine。

## Decision 决定

**v3.0 只做一件事：把 OpenAI HTTP TTS 调用抽取成 provider，并定义带类型的结果契约（blob 形态）。不预测、不实现 Realtime/stream 路径。**

### 接口

```js
// src/core/ttsProvider.js

/**
 * @typedef {Object} TTSRequest
 * @property {string} text
 * @property {string} voice
 * @property {string} sessionId
 * @property {number} ttsQueueId
 * @property {number} chunkIndex
 */

/**
 * @typedef {Object} BlobTTSResult
 * @property {'blob-url'} kind
 * @property {string} url
 * @property {() => void} revoke   // idempotent
 */

/**
 * Provider contract. v3.0 only defines kind='blob-url'.
 * Future kinds (e.g. 'pcm-stream') will be added in the Realtime ADR,
 * NOT pre-declared here.
 *
 * synthesize(request, signal) -> Promise<BlobTTSResult>
 * Throws TTSError on failure.
 */
export class TTSError extends Error {
  constructor({ provider, model, status, body, message }) {
    super(message)
    this.provider = provider
    this.model = model
    this.status = status    // HTTP status or null (network)
    this.body = body        // truncated response body for logs
  }
}
```

### v3.0 实现：`OpenAIStandardTTS`

```js
export class OpenAIStandardTTS {
  constructor({ apiKey, model = 'gpt-4o-mini-tts' }) {
    this.apiKey = apiKey
    this.model = model
    this.name = 'openai-standard'
  }

  async synthesize(req, signal) {
    let res
    try {
      res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          input: req.text,
          voice: req.voice || 'nova',
          response_format: 'mp3'
        }),
        signal
      })
    } catch (err) {
      throw new TTSError({ provider: this.name, model: this.model, status: null, body: null, message: err.message })
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500)
      throw new TTSError({ provider: this.name, model: this.model, status: res.status, body, message: `TTS HTTP ${res.status}` })
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    let revoked = false
    return {
      kind: 'blob-url',
      url,
      revoke: () => { if (!revoked) { revoked = true; URL.revokeObjectURL(url) } }
    }
  }
}
```

### audioEngine 改动

- `play(session, chunks, voice, provider, onEvent)` — 第 4 个参数从函数改为 provider 对象
- 每个 chunk：`const result = await provider.synthesize({...}, signal)`
- `if (result.kind !== 'blob-url') throw` —— 未知 kind 显式失败，不静默
- 播放结束或取消 → `result.revoke()`；同时 `session.trackRevoker(result.revoke)` 保证 forceReset 时兜底释放
- 播放逻辑（持久 `<audio>`、prefetch、autoplay 检测）**不变**

## Alternatives Considered

### A：不抽取，12 月再改
- 优点：现在零工作量
- 缺点：12 月同时改 services + audioEngine，在死线压力下 regression 风险高
- 没选

### B：抽取 + 同时预声明 stream 契约 / 实现 stream 路径
- 优点：看起来"一步到位"
- 缺点：Realtime 的真实需求（PCM 格式、采样率、分片顺序、backpressure、cancel、barge-in、断线重连、完成信号）现在都是**未验证假设**，提前写出来大概率写错，12 月仍要返工；未使用的代码路径是负资产
- 没选（Codex round-2 BLOCKING 意见）

### C（采纳）：只抽取 blob provider + typed result + 每次调用的 revoke
- 用户可见收益为零；**工程收益是提前隔离 TTS 调用边界**，并修正 blob URL 生命周期管理
- 选它

## Consequences

### Positive
- 12 月迁移时，services 层不需要再动 audioEngine 调用签名
- blob URL 生命周期由 result 自己负责，内存泄漏面缩小
- provider 可 mock，audioEngine 单元测试成为可能
- TTSError 带 status/body/model，日志与错误分类可用

### Negative
- 新增约 80-100 行代码
- **12 月仍需改 audioEngine**（新增 stream 播放分支）——本 ADR 只能"减少"改动，不能"消除"改动

### Neutral
- 用户可感知行为、成本均不变

## Open Items for the Future Realtime ADR（不在本次实施）

12 月写 Realtime TTS ADR 时必须先验证并回答：
1. 输出 PCM 格式 / 采样率 / 声道
2. 分片顺序与是否需要重排
3. backpressure：播放慢于生成时如何处理
4. cancel 语义：如何中止服务端生成
5. barge-in：新 session 打断旧 session 的行为
6. 断线重连 & 部分音频的处理
7. 完成信号：如何确定一条 utterance 播完
8. 是否仍能在无后端前提下建立连接（BYO key vs ephemeral token）

## Status History
- 2026-10-08: Draft
- 2026-10-08: Revised after Codex round-2（收窄 scope：仅 blob 契约；typed result；per-call revoke；TTSError）
