---
id: ADR-002
title: FSM Reducer + sessionId + 每阶段 attemptId 异步状态架构
status: Approved
author: Claude
approved_by: jimen
approved_at: 2026-06-29
related_prd: PRD-001
---

# FSM Reducer + sessionId + 每阶段 attemptId

## Context

v1.x 用分散的 React state + refs（`stateRef.current`, `activeButtonRef.current`, `sendInFlightRef.current`）管理翻译状态。结果：

- 异步回调到达时 ref 已被新操作污染 → 翻译方向错乱
- 重试请求超时后旧请求的回应仍被接受 → 重复播报
- Shift 键 keyup 漏掉时 listening 状态永久卡住

根本病灶：**异步副作用没有持久的所有权边界**。

## Decision

v2.0 采用三层防护机制：

1. **`useReducer` 驱动的 FSM**：状态转移是纯函数，所有变更走 dispatch
2. **每次操作创建 Session**：immutable id + 不可变 direction + 资源池 + AbortController
3. **每阶段独立 attemptId**：transcribe / translate / tts 各自计数，retry 时递增

**Stale event rejection 规则**（reducer 顶层执行，发生在任何 side effect 之前）：

```
event.type ∉ {RESET, RECOVER, SETTINGS_CHANGED, START}
  AND (
    event.sessionId ≠ state.session.id
    OR event.<phase>AttemptId ≠ state.session.attemptIds.<phase>
  )
  → 静默丢弃事件（仅记录在 lastEventLog 用于调试）
```

## Alternatives Considered

### 方案 A：单 sessionId（无 attemptId）
- **优点**: 简单
- **缺点**: 同 session 内的 retry 竞态无法防护 — translate A 超时启动 B，A 晚到被接受，造成重复
- **没选**: Codex 在评审时给出反例，证明 sessionId-only 不足够

### 方案 B：引入 XState 状态机库
- **优点**: 形式化、可视化
- **缺点**: 学习曲线、bundle 体积、对小项目过度工程
- **没选**: useReducer 已足够，39 个测试可覆盖

### 方案 C（采纳）：useReducer + sessionId + per-phase attemptId
- **优点**: 简单、纯函数、可单元测试、防同 session retry 竞态
- **缺点**: 需要严格执行 "stale 事件先过滤再 side effect" 的约定
- **选了它**: 验证可行 — 39/39 测试通过

## Consequences

### Positive
- v1.x 的 4 个致命问题全部根治（方向错乱 / 长录音 / 卡死 / 重复）
- 测试覆盖：sessionManager + reducer 是纯逻辑，可在 Node 下 `node --test` 跑
- 调试友好：所有事件（含被拒绝的）记录在 `lastEventLog`，可追溯

### Negative
- 异步回调编写时必须显式传递 `{sessionId, attemptId}` 才能被接受 — 增加一点样板代码
- 每个 service 函数必须接受 AbortSignal 参数

### Neutral
- 跟 Redux Toolkit / Zustand 都不兼容（用了原生 useReducer）— 未来切换需要工作量

## Status History
- 2026-06-29: Approved（来自 Codex round 1 评审）

## Related
- 实现：`src/core/sessionManager.js`, `src/core/translatorFSM.js`, `src/hooks/useTranslator.js`
- 测试：`src/core/__tests__/fsm.test.js`（23 case 含 Codex 提议的 #1/#2/#3/#4/#9/#10）
