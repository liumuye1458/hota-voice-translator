---
id: ADR-003
title: TTS 用 MP3 + 持久 Audio 元素，不用 MediaSource API
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-06-29
related_prd: PRD-001
---

# TTS 用 MP3 + 持久 Audio 元素，不用 MediaSource API

## Context

v2.0 PRD 一度倾向用 PCM 流式 + AudioWorklet 实现"300ms 首字播放"。Codex 评审时指出两个 BLOCKING 问题：

1. **MediaSource API "Limited Availability"**：MDN 标注其非 Baseline，多浏览器兼容性差
2. **Safari iOS 多 `<audio>` 元素自动播放权限丢失**：每个新建的 Audio 元素需要独立用户手势授权，循环创建会破坏体验

## Decision

v2.0 采用：
- **TTS 输出格式**: MP3（OpenAI `response_format: 'mp3'`）
- **播放方式**: 单一**持久**的 `HTMLAudioElement`，反复 `src` 赋值
- **流畅感**: 通过 sentenceChunker 将长文本切成 ≤3200 字符的多个 chunk，**并行预取 + 顺序播放**
- **AudioContext**: 仍创建 24kHz 实例（为未来 PCM 路径预留，但 v2.0 不走）

## Alternatives Considered

### 方案 A：PCM 流式 → AudioWorklet 处理 → 实时播放
- **优点**: 真正的"首字 300ms"播放
- **缺点**:
  - 需要 PCM 采样率匹配（24kHz vs 浏览器 AudioContext 默认 48kHz），naive 播放会变速
  - AudioWorklet 加载、ring buffer 实现、resampling 都需要写 worklet 代码
  - 在 Safari iOS 上 worklet 路径不可靠
- **没选**: 收益 vs 复杂度不成比例；v2.1 可选优化

### 方案 B：MediaSource API + AAC 流
- **优点**: 标准化方案
- **缺点**: "Limited availability"、需要正确的 codec/container 配置
- **没选**: Codex 强烈反对

### 方案 C（采纳）：MP3 blob + 持久 Audio 元素 + 多段并行预取
- **优点**:
  - 跨浏览器极其稳定（Audio 元素是 HTML 最稳定的多媒体 API）
  - Safari iOS 自动播放权限一次授权后持续有效
  - 实现复杂度低，bug 表面积小
- **缺点**:
  - 第一个 chunk 需要等待完整 MP3 生成（~1-2s vs PCM 流式 300ms）
  - 多 chunk 之间的缝隙（不显著，因为有预取）
- **选了它**: 稳定性优先于极致延迟

## Consequences

### Positive
- 跨浏览器一致行为（Chrome / Edge / Android Chrome / iOS Safari）
- 代码量小：`audioEngine.js` 仅 222 行
- 持久 Audio 元素一次解锁全程有效

### Negative
- 长翻译的第一字播放有 1-2s 等待（vs 真实流式 300ms）
- 未来若要"对话感"延迟更短，仍需切到 PCM 路径

### Neutral
- AudioContext 仍创建（24kHz 配置就绪），但 v2.0 仅用于 unlock，不做实际播放

## Migration Path（v2.1 可选）

如未来需要追求更低延迟：
1. 添加 PCM AudioWorklet 路径
2. capability detect（Chrome/Edge → PCM, Safari/iOS → 当前 MP3 路径）
3. 不影响 v2.0 架构其他部分

## Status History
- 2026-06-29: Approved（来自 Codex round 1 评审）

## Related
- 实现：`src/core/audioEngine.js`
- 相关 PRD：PRD-001 §5
