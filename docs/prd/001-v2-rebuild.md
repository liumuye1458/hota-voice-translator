---
id: PRD-001
title: v2.0 完全重构 — 从"一坨屎"到生产可用
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-06-29
---

# v2.0 完全重构

## 1. Problem 问题

v1.x 版本在 CEO 实际使用中出现 4 个致命问题，已经到了"必须不断手动复位才能勉强用"的程度：

1. **方向错乱**：中文进 → 中文出 / 中文进 → 英文出，几句对话后必然发生
2. **长印尼语丢字**：Web Speech API 60 秒上限 + 静默 5 秒断流 + interim 覆盖问题
3. **长翻译 TTS 失败**：OpenAI TTS 4096 字符上限，超出静默失败
4. **状态卡死**：Shift 键 keyup 漏掉（alt-tab、输入法吞事件等）后无限自动重启识别

打补丁解决不了——是架构层面的异步状态污染。

## 2. User 用户

PT HOTA DIGITAL SOLUTIONS 的中方管理层（jimen）和印尼籍员工。CEO 用工具下达运营指令、跟员工实时沟通、做 HR/数据/直播相关交流。

## 3. Goals 目标

### Must
- [x] 方向不会错乱（连续 50 次操作翻译方向 100% 准确）
- [x] 长印尼语（60 秒+）100% 不丢字
- [x] 长中文翻译（4000+ 字符）能完整播报
- [x] 任何卡死状态 1 秒内可恢复到 idle
- [x] 单元测试覆盖核心 FSM 和 chunker

### Should
- [x] 翻译质量保持 v1 同等（gpt-4o，不降级到 mini）
- [x] 业务术语 / 员工名字识别准确率提升（STT prompt）
- [x] 高保真翻译（不软化批评、不加客套）

### Could
- [x] 自定义指令注入企业沟通规范
- [x] 流式 TTS 播放（已为未来 PCM 路径预留架构）

## 4. Non-Goals 不做

- ❌ gpt-realtime-translate（音频端到端，成本 6-20 倍超预算）
- ❌ 后端 / 服务器（保留纯 PWA + 用户自带 API Key）
- ❌ 声音克隆 / 模仿 CEO 音色
- ❌ 多人会话区分（diarization）
- ❌ 右路实时 interim 文字显示

## 5. Solution 解决方案

完全推翻 v1 架构，5 天工程重写：

| 层 | v1 | v2 |
|----|----|----|
| 状态管理 | 分散的 React state + refs | **`useReducer` + 不可变 Session 对象 + sessionId** |
| 异步竞态 | 无防护 | **每阶段独立 attemptId + 全链路 AbortController** |
| 右路 STT | Web Speech API | **MediaRecorder + gpt-4o-transcribe** |
| TTS 模型 | tts-1-hd | **gpt-4o-mini-tts** |
| 长文本处理 | 失败 | **sentenceChunker 自动 3200 字符分段 + 队列播放** |
| 错误恢复 | 手动 | **2 同类错误 5 秒内自动 reset + Esc + window blur** |

具体架构决策见 [ADR-001](../adr/001-no-backend.md), [ADR-002](../adr/002-fsm-with-session-ids.md), [ADR-003](../adr/003-tts-mp3-not-mediasource.md)。

## 6. Acceptance Criteria 验收标准

- [x] `npm test` 通过（最低 39 个 case）
- [x] `npm run build` 成功
- [x] 浏览器 dev server smoke test 零运行时错误
- [x] CEO 实测 8 次连续翻译，**不需要手动复位**（已在 2026-06-29 通过）
- [x] Codex 评审通过（round 1 + round 2 反馈全部吸收）
- [x] 翻译金标准 20 case 测试集就位

## 7. Open Questions 未决问题

无（实施完成后清零）。

## 8. Risks 风险

| 风险 | 缓解 |
|------|------|
| `gpt-4o-mini-tts` 印尼语音质未必比 tts-1-hd 好 | CEO 实测，2026-06-29 接受 |
| Safari iOS 自动播放策略 | 持久 `<audio>` 元素 + autoplay-rejection 检测 |
| STT 录音超过 60 秒上传慢 | 用 stream=true 增量返回 |
| 突然部署翻车 | stable-v1.0 标签保留，一键 reset --hard 回滚 |

## 9. 实施记录

- **Branch**: `v2-rebuild`（已合并到 main 后删除）
- **Tag**: `stable-v2.0` (commit ed97dbf)
- **删除**: 518 行 v1 死代码（5 个 hooks/components）
- **新增**: 1230 行 v2 代码 + 39 单元测试

## Related
- ADR-001、ADR-002、ADR-003
- 历史包袱: 原 `ARCHITECTURE_v2.md`（已废弃，内容拆入 PRD + ADR）
