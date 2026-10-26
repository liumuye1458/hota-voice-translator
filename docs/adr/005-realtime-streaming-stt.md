---
id: ADR-005
title: 按住期间流式识别（Realtime transcription，浏览器直连，上传识别兜底）
status: Approved
author: Claude
approved_by: jimen（全权委托，见 DEC-2026-10-27-v4-delegation）
approved_at: 2026-10-27
related_prd: PRD-003
---

# 按住期间流式识别

## Context
v3.0 松手后才上传整段录音再识别，松手→文字 0.9–1.9 s，且随录音长度和网络上传速度增长。OpenAI Realtime transcription 允许边说边送音频，松手只需等最后一小段（实测 0.54–0.84 s）。ADR-001 规定无后端：凭证必须在浏览器内用用户自己的 Key 获取。

## Decision

### 鉴权（已实测）
1. 浏览器 `POST /v1/realtime/client_secrets`（Authorization: 用户 Key；CORS `*`），session = `{type:'transcription', audio.input: {format: pcm 24k, transcription: {model, language, prompt}, turn_detection: null}}`。
2. 拿到的临时凭证**可复用、10 分钟有效**：按语言（zh / 目标语言）+ 模型 + prompt 缓存，过期前 60 s 视为失效；页面加载和每轮结束后预取，按下时通常已就绪。
3. WebSocket `wss://api.openai.com/v1/realtime`，子协议 `['realtime', 'openai-insecure-api-key.<临时凭证>']`。用户长期 Key 不进 WebSocket。

### 采集
- 独立 capture AudioContext + AudioWorklet（Blob URL 内联模块，无需额外构建产物）→ Float32 帧 → 主线程线性重采样到 24 kHz → PCM16 → base64，每 ~100 ms 一个 `input_audio_buffer.append`。
- 连上之前的音频进内存队列，连上后补发（实测补发整段 12 s 仍正确）。
- MediaRecorder **照常同时录音**作兜底。

### 结束与回退（核心不变量：任何失败都不比 v3 差）
| 松手时状态 | 行为 |
|---|---|
| 已连上 | flush → `commit` → 等 `conversation.item.input_audio_transcription.completed`，**3.5 s** 超时 |
| 未连上 / 连接已失败 / 采集不支持 | 直接用兜底录音走上传识别（v3 路径） |
| 有效音频 < 100 ms | 视为空输入（服务端会拒绝 <100 ms 的提交） |
| Realtime 报错 / 超时 / 返回空 | 回退上传识别；`stt_path='upload-fallback'` + `fallback_reason` |
| 采集 0.8 s 内未就绪（AudioContext 未恢复） | 回退上传（`capture-not-ready`） |
| 采集比录音晚 >150 ms 就绪（开头几个字只在兜底录音里） | 回退上传（`capture-started-late`） |

- 采集 AudioContext 在**按下手势内同步**创建/恢复（`warmCapture()`），iOS 中断后也能恢复。

- 会话的所有 Realtime 资源（WS、AudioContext、worklet）登记到 `session.addCleanup()`，`cancel()`/`forceReset()` 时统一关闭；迟到事件被 session 过期过滤丢弃（ADR-002 不变）。
- FSM 不变：仍是 RECORDING → TRANSCRIBING → TRANSLATING → SPEAKING。

## Alternatives
- **WebRTC**：浏览器原生、自带 Opus 编码；但需 SDP 交换、数据通道事件、调试面更大。按键式单向上传，WebSocket + PCM 足够，且可在 Node 里用同一鉴权方式测试 → 选 WebSocket。
- **gpt-transcribe 走 Realtime**：只在提交后处理，实测更慢 → 不选（仍保留为上传模式选项）。
- **gpt-realtime-translate（端到端语音翻译）**：快，但无词表/指令，不适配按键式 → 列为后续评测。
- **常驻长连接**：省 ~1 s 连接时间，但空闲连接生命周期、计费、断线重连复杂；连接本来就和说话时间重叠 → 不做。

## Consequences
- + 松手后识别省 0.4–1.1 s；长句、慢网收益更大。
- + 统一 PCM/Realtime 基础设施，12 月 TTS 迁移可复用鉴权与 WS 封装。
- − 新增约 250 行代码；按住期间多一条 WS（实时识别 $0.017/min，低于翻译成本量级）。
- − 失败回退那一句会比 v3 稍慢（多等了超时）——超时取 3.5 s 并记录 `fallback_reason` 以便调整。

## Status History
- 2026-10-27: Draft + Approved（CEO 全权委托）
- 2026-10-27: Codex 审查后补充两条回退（capture-not-ready / capture-started-late）与手势内恢复
