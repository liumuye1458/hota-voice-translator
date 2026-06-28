# HOTA Voice Translator v2.0 — Architecture Spec

**Status**: APPROVED (post Codex review round 1)
**Author**: Claude
**Date**: 2026-04-29
**Approved scope**: 3-5 work days, ~$0.175/day, "push-to-talk translator" positioning

---

## 1. Design Goals (Non-Negotiable)

1. **No direction corruption.** Direction is locked at session creation, never recomputed from UI state.
2. **No stuck listening.** Every recording auto-terminates within a deterministic time budget.
3. **No silent failures.** Every failure path surfaces visibly within 500ms.
4. **Long content survives.** 60s+ Indonesian recordings keep every word; 4000+ char Chinese translations play end-to-end.
5. **Single source of truth.** Reducer-based FSM; no mutable refs read inside async callbacks.
6. **No backend, no realtime API.** localStorage API key, pure PWA. (Realtime needs ephemeral tokens → out of scope.)

---

## 2. Module Boundaries

```
src/
├── core/                                # No React. No DOM.
│   ├── sessionManager.js                # Session lifecycle, sessionId + per-phase attemptIds
│   ├── translatorFSM.js                 # Reducer + transitions
│   ├── audioEngine.js                   # AudioContext(24kHz), PCM worklet, persistent <audio>
│   ├── audio-worklet.js                 # PCM ring buffer worklet (loaded via addModule)
│   ├── sentenceChunker.js               # Boundary-aware text splitting
│   └── eventBus.js                      # Pub-sub; all events carry sessionId + attemptId
├── services/
│   └── openai.js                        # Pure async fetch wrappers with AbortController support
├── hooks/
│   └── useTranslator.js                 # React adapter to reducer + dispatchers
├── components/
│   ├── App.jsx                          # Composition root
│   ├── DualVoiceButton.jsx              # Keyboard + pointer → FSM dispatch
│   ├── TextInputBar.jsx                 # WeChat bridge → FSM dispatch
│   ├── ConversationView.jsx
│   ├── StatusBar.jsx
│   └── SettingsPanel.jsx
└── evals/
    ├── translation-golden.json          # 20 prompt-quality cases
    ├── fsm-integration.test.js          # 10 deterministic state-machine tests
    └── runEvals.mjs                     # CLI: node evals/runEvals.mjs
```

**Rule**: nothing in `components/` mutates state outside `dispatch(action)`. Nothing in `core/` knows about React.

---

## 3. Finite State Machine

### 3.1 States
```
idle           # No active session
recording      # MediaRecorder OR browser STT running
transcribing   # Right-path audio uploaded, awaiting transcript
translating    # Text sent to gpt-4o, awaiting reply
speaking       # Audio chunks playing (may overlap with chunk generation)
error          # Transient; auto → idle after 3s via RECOVER event
```

### 3.2 Events

All events except `RESET` and `RECOVER` carry `{sessionId, attemptId, ...payload}`. Stale events (mismatching sessionId or attemptId) are no-ops, logged for debugging.

```
START               { side: 'left'|'right', inputMode: 'voice'|'text', text? }
STOP                { sessionId }                                # User released button
TRANSCRIPT_READY    { sessionId, transcribeAttemptId, text }
TRANSLATION_READY   { sessionId, translateAttemptId, text }
CHUNK_QUEUED        { sessionId, ttsQueueId, chunkIndex, totalChunks }
CHUNK_PLAYING       { sessionId, ttsQueueId, chunkIndex }
CHUNK_FAILED        { sessionId, ttsQueueId, chunkIndex, error }
SPEAK_DONE          { sessionId, ttsQueueId }
ERROR               { sessionId, attemptId, code, message }
TIMEOUT             { sessionId, attemptId, phase }
RESET               { reason: 'user'|'window-blur'|'timeout'|'error-burst' }  # bypasses session check
RECOVER             {}                                                          # bypasses session check; error→idle
SETTINGS_CHANGED    { settings }                                                # bypasses session check
SPEAK_PROGRESS      { sessionId, ttsQueueId, chunkIndex, total }
EMPTY_INPUT         { sessionId }                                # User released without speaking; → idle
```

### 3.3 Transition Rules

| State | Event | Next | Side-effect |
|-------|-------|------|------------|
| any (incl. non-idle) | START | recording or translating (text mode) | **Cancel current session first**, mint new sessionId, dispatch internally |
| idle | START(voice) | recording | sessionManager.create(); audioEngine.unlock(); MediaRecorder.start() (right) OR webSpeech.start() (left fallback) |
| idle | START(text) | translating | sessionManager.create(); openai.translate() |
| recording | STOP (left text mode N/A) | transcribing (right voice) OR translating (left voice) OR idle (no speech) | MediaRecorder.stop(); upload blob OR pass interim text |
| recording | EMPTY_INPUT | idle | cleanup |
| recording | TIMEOUT(30s) | error | cleanup; toast |
| transcribing | TRANSCRIPT_READY | translating | openai.translate() |
| transcribing | TIMEOUT(20s) | error | abort fetch; toast |
| translating | TRANSLATION_READY | speaking | sentenceChunker.split(); audioEngine.queue() |
| translating | TIMEOUT(20s) | error | abort fetch; toast |
| speaking | SPEAK_DONE | idle | sessionManager.dispose() |
| speaking | CHUNK_FAILED | speaking (continue) | skip chunk, toast |
| any | ERROR | error | recordError(); schedule RECOVER in 3s |
| any | TIMEOUT | error | (same as ERROR) |
| any | RESET | idle | sessionManager.cancelAll(); drainAll() |
| error | RECOVER | idle | clear timeout |

**START-during-active rule**: any new START internally first dispatches an implicit cancellation of the current session (no separate user-visible RESET), then proceeds.

---

## 4. Session & Attempt Model

```js
class Session {
  id              // crypto.randomUUID()
  direction       // 'zh→id' | 'id→zh' — IMMUTABLE
  inputMode       // 'voice' | 'text'
  createdAt
  abortControllers: {
    transcribe, translate, tts        // per-phase
  }
  attemptIds: {
    transcribeAttemptId: number,      // increments on each retry within the same session
    translateAttemptId: number,
    ttsQueueId: number,
  }
  resources: { mediaStream, mediaRecorder, currentAudioPlayback }
  errors: [{ts, code, msg}]
  cancelled: boolean

  newTranscribeAttempt() { this.attemptIds.transcribeAttemptId++; return ... }
  newTranslateAttempt()  { ... }
  newTtsQueue()          { ... }
  cancel(reason)         // abort all controllers, dispose resources, mark cancelled
}
```

### Stale event filtering (mandatory, before any side effect)

In the reducer:
```js
function reducer(state, event) {
  if (event.type !== 'RESET' && event.type !== 'RECOVER' && event.type !== 'SETTINGS_CHANGED') {
    if (!state.session || event.sessionId !== state.session.id) {
      log('stale event ignored', event)
      return state
    }
    // Per-phase attempt check (where applicable)
    if (event.type === 'TRANSCRIPT_READY' &&
        event.transcribeAttemptId !== state.session.attemptIds.transcribeAttemptId) {
      return state
    }
    // ...same for TRANSLATION_READY (translateAttemptId), CHUNK_* (ttsQueueId)
  }
  // Pure transition
}
```

**Critical**: services (openai.js) must capture `{sessionId, attemptId}` at request time and pass them back in the resolution event. No async function inspects current state.

---

## 5. Audio Engine

### 5.1 AudioContext setup (24kHz to match OpenAI PCM)

```js
async unlock() {
  if (this.unlocked) return
  try {
    this.ctx = new AudioContext({ sampleRate: 24000 })
  } catch {
    this.ctx = new AudioContext()  // browser refused custom rate; will need resampling
    this.needsResample = (this.ctx.sampleRate !== 24000)
  }
  if (this.ctx.state === 'suspended') await this.ctx.resume()

  // Load worklet
  await this.ctx.audioWorklet.addModule('/audio-worklet.js')

  // iOS silent buffer poke
  const buf = this.ctx.createBuffer(1, 1, this.ctx.sampleRate)
  const src = this.ctx.createBufferSource()
  src.buffer = buf; src.connect(this.ctx.destination); src.start(0)

  // Pre-warm persistent <audio> element for Safari fallback path
  this.fallbackAudio = document.createElement('audio')
  this.fallbackAudio.preload = 'auto'

  this.unlocked = true
}
```

### 5.2 Playback strategy (per-chunk)

```js
async playChunk(sessionId, ttsQueueId, chunkIndex, text) {
  // Capability detection
  const canStream = !!window.AudioWorkletNode && !this.isSafariMobile()

  if (canStream) {
    // Primary: PCM stream → AudioWorklet
    const res = await fetch('/v1/audio/speech', {
      ...,
      body: JSON.stringify({ model: 'gpt-4o-mini-tts', input: text, response_format: 'pcm' })
    })
    const reader = res.body.getReader()
    // Pump PCM bytes to worklet ring buffer
    // Resample if needsResample (linear interpolation in worklet)
  } else {
    // Safari fallback: full MP3 blob → persistent <audio> element
    const res = await fetch(..., { response_format: 'mp3' })
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    this.fallbackAudio.src = url  // REUSE same element
    try {
      await this.fallbackAudio.play()
    } catch (e) {
      // Autoplay rejected — show tap-to-play UI
      emit('TAP_TO_PLAY_REQUIRED', { sessionId, ttsQueueId })
    }
    this.fallbackAudio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true })
  }
}
```

### 5.3 Sentence Chunker

```js
// Budget: 3200 chars per chunk (under 4096 OpenAI limit, with UTF-16 margin)
// Counts JS .length (UTF-16 code units), not code points — conservative is fine
// Boundary priority: 。！？\n\n  >  . ! ?  >  ， , ;  >  space  >  char
chunker.split(text, { maxChars: 3200 }): string[]
```

Required test cases (in eval suite):
- Single 4000-char no-punctuation sentence → splits at clause/word boundaries
- Mixed Chinese+English punctuation
- Numbers with decimals ("3.14" must not split at the .)
- Currency "Rp 1.500.000"
- Trailing whitespace / blank lines
- Emoji at boundaries

### 5.4 Mobile Audio Unlock

Wired in App.jsx:
```js
useEffect(() => {
  const unlock = () => audioEngine.unlock()
  document.addEventListener('pointerdown', unlock, { once: true })
  document.addEventListener('keydown', unlock, { once: true })
  return () => {
    document.removeEventListener('pointerdown', unlock)
    document.removeEventListener('keydown', unlock)
  }
}, [])
```

---

## 6. STT Strategy (Simplified — single-tier per side)

### 6.1 Left Path (Chinese)
- **Default**: WeChat Ctrl+Win → text in input → user taps left Shift → dispatch START(left, text)
- **Fallback** (input empty + hold left Shift): browser SpeechRecognition with 25s session cap. On STOP, deliver accumulated final text.

### 6.2 Right Path (Target language)

**Single approach**: MediaRecorder → `gpt-4o-transcribe`.

- Codec preference: `audio/webm;codecs=opus` (Chrome/Edge/Android Chrome/Firefox)
- Fallback: `audio/mp4` (Safari iOS)
- Detect via `MediaRecorder.isTypeSupported()`

```js
const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
const mime = mimeCandidates.find(m => MediaRecorder.isTypeSupported(m))
```

On STOP:
- Upload full blob to `/v1/audio/transcriptions` with:
  - `model: 'gpt-4o-transcribe'`
  - `prompt: <user-configured business vocabulary>`
  - `stream: true` (for faster perceived response — text deltas stream after upload completes)

**Realtime / WebSocket STT explicitly NOT in v2.0** — would require backend ephemeral-token broker. Documented in `out-of-scope` section.

### 6.3 STT Prompt (User-Configurable)

Stored in settings as `sttVocabulary`. Default:
```
HOTA Indonesian live-streaming context.
Common terms: GMV, ROI, CTR, 福利款, 破价, 憋单, 流量, 转化, 退款率, 直播间.
Currency: IDR, CNY.
Staff names: [editable list].
```

UI: textarea in SettingsPanel labeled "STT 词汇库 / Transcription vocabulary".

---

## 7. Translation Pipeline

- Model: `gpt-4o`, temperature 0
- Prompt: existing simplified prompt + `settings.customInstructions` injection
- Output-language post-check: `isChineseDominant()` heuristic
- On mismatch: 1 retry with stronger language-forcing prompt prefix
- Source/target derived from `session.direction` (NOT from any global ref)

---

## 8. Error Recovery & Force Reset

### 8.1 Auto-Reset Triggers
| Condition | Window | Action |
|-----------|--------|--------|
| 2× same error code | 5s | RESET('error-burst') |
| State === recording | > 30s | TIMEOUT then RESET |
| State === transcribing | > 20s | TIMEOUT |
| State === translating | > 20s | TIMEOUT |
| State === speaking, no chunk progress | > 60s | RESET('timeout') |
| Window blur | — | RESET('window-blur') |
| Esc key | — | RESET('user') |
| Reset button click | — | RESET('user') |

### 8.2 forceReset() Drain Checklist (mandatory order)

```js
function forceReset(reason) {
  // 1. Mark all sessions cancelled (stale-rejection takes effect immediately)
  sessionManager.cancelAll()

  // 2. Abort all in-flight HTTP requests
  for (const session of sessionManager.allActive()) {
    session.abortControllers.transcribe?.abort()
    session.abortControllers.translate?.abort()
    session.abortControllers.tts?.abort()
  }

  // 3. Clear all timers (auto-reset timers, recovery timer, debounce)
  timers.clearAll()

  // 4. Stop browser STT if running
  webSpeechRecognition?.abort()

  // 5. Stop MediaRecorder before tracks (order matters)
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.ondataavailable = null  // detach handler
    try { mediaRecorder.stop() } catch {}
  }

  // 6. Stop media stream tracks
  mediaStream?.getTracks().forEach(t => t.stop())

  // 7. Stop audio playback
  audioEngine.stop()
  //   - cancel worklet input streams
  //   - pause fallbackAudio element (do NOT destroy it)
  //   - revoke all blob URLs in active queue

  // 8. Clear keyboard pressed-state (for stuck-Shift edge case)
  keyboardState.clearAll()

  // 9. Drain eventBus queue
  eventBus.flush()

  // 10. Reset reducer
  dispatch({ type: 'RESET', reason })
}
```

**Note**: `abort()` cancels the local network/stream; OpenAI may still bill if the request reached their service. Correctness comes from stale-rejection, not from abort.

### 8.3 Per-Phase Specific Recovery (within session, not forceReset)
| Phase | Error | Recovery |
|-------|-------|----------|
| transcribing | timeout | 1 retry with `newTranscribeAttempt()` |
| translating | timeout | 1 retry with `newTranslateAttempt()` + stronger prompt |
| translating | wrong-language detected | 1 retry with all-caps language-forcing prefix |
| speaking | chunk failed | skip, continue queue, toast |

---

## 9. Evaluation (Two-Tier)

### 9.1 Translation Quality (20 cases)

File: `evals/translation-golden.json`

Categories (4 each, 5 categories):
- **Business direct** — "明天直播 8 点开始" type
- **Stern/criticism** — "你昨天又迟到了" type
- **Numbers & currency** — "GMV 是 50 juta IDR"
- **Code-switching** — mixed Chinese+English+Indonesian
- **Edge cases** — empty, single-word, very long, names

Each case:
```json
{
  "id": "biz-direct-001",
  "direction": "zh→id",
  "input": "...",
  "must_contain": [...],     // ALL must appear (case-insensitive)
  "must_not_contain": [...], // NONE allowed (softeners, wrong language)
  "register": "direct|stern|warm|technical",
  "notes": "..."
}
```

### 9.2 FSM Integration Tests (10 cases, deterministic)

File: `evals/fsm-integration.test.js`

Mocked openai.js + audioEngine. Tests:
1. `fsm-start-during-speaking-cancels-old` — second START aborts first
2. `fsm-reset-mid-fetch-drops-late-result` — translation resolves after RESET; ignored
3. `fsm-error-auto-recovers-3s` — error state transitions to idle after RECOVER
4. `fsm-direction-rapid-left-right-shift` — alternate left/right 10× rapid presses; no direction leak
5. `fsm-stt-timeout-30s-resets` — recording stuck → timeout → reset
6. `fsm-retry-stale-rejection` — translate A retry B; A late resolves; ignored
7. `fsm-chunk-fail-continues-queue` — chunk 2 of 5 fails; chunks 3-5 still play
8. `tts-chunk-budget-3200-boundary` — text exactly 3200/3201 chars splits correctly
9. `tts-long-no-punctuation` — 5000 char no-punct text → ≥2 chunks at word boundaries
10. `empty-input-no-api-call` — STOP with no speech does not call translate/tts

### 9.3 Runner

```bash
node evals/runEvals.mjs translation  # runs 20 cases against live OpenAI
node evals/runEvals.mjs fsm          # runs 10 mock tests, no API calls
node evals/runEvals.mjs all
```

Output: pass/fail summary + diff vs `evals/history/latest.json` + total $ cost.

**Mandatory** before every prompt or model change.

---

## 10. Migration Plan

1. New branch `v2-rebuild` from current main
2. v2 code lives in `src/core/`, `src/hooks/useTranslator.js`, with App.jsx rewriting how state is wired
3. v1 components kept (DualVoiceButton, TextInputBar, etc.) but **only one event handler set mounts** — controlled by env flag `USE_V2_FSM` (default true on branch)
4. `stable-v1.0` git tag remains as fallback on main
5. Cutover criteria (all must pass):
   - All 10 FSM integration tests pass
   - 19/20 translation golden cases pass (1 allowed for subjective Indonesian phrasing)
   - CEO smoke test 30+ turns without forced reset
   - Cross-browser smoke: Chrome desktop, Edge, Android Chrome, iOS Safari PWA
6. Cutover: merge to main, tag `stable-v2.0`

---

## 11. Known Trade-offs (Explicit)

| Choice | Sacrifice | Justification |
|--------|----------|--------------|
| MediaRecorder + transcribe (no realtime STT) | No live interim text on right path | Realtime needs backend; long-record reliability matters more |
| `stream: true` on transcribe response | Slightly more code | Cuts post-stop wait by ~40% |
| Web Audio PCM primary, MP3 blob for Safari | Safari iOS gets ~1s extra latency | MediaSource too brittle |
| Keep gpt-4o for translation | $0.03/day vs mini's $0.002 | Eval-validated quality |
| Drop tiered STT (no 8s auto-switch) | Loses theoretical realtime upgrade | Cannot retroactively convert opus blob to PCM stream |
| No backend / token broker | localStorage API key | Internal tool; CEO authorized |

---

## 12. Out of Scope for v2.0

- gpt-realtime-translate (audio↔audio; budget rejected)
- gpt-realtime-whisper / WebSocket realtime STT (requires backend ephemeral tokens)
- Voice cloning
- Multi-speaker diarization
- Real-time interim text on right path
- Backend / cloud sync / multi-device session sync
- Built-in industry dictionary as code (handled via customInstructions + sttVocabulary)

---

## 13. Implementation Plan

| Day | Tasks |
|-----|-------|
| **Day 1 AM** | Create v2-rebuild branch; `core/sessionManager.js` + `core/translatorFSM.js` + `core/eventBus.js`; unit-test stale-event filtering |
| **Day 1 PM** | `core/audioEngine.js` skeleton + `core/audio-worklet.js` PCM worklet; `core/sentenceChunker.js` with edge-case tests |
| **Day 2 AM** | Rewrite `services/openai.js`: streaming TTS (PCM + MP3 fallback), transcribe with `stream:true` + prompt, AbortController on every call |
| **Day 2 PM** | `hooks/useTranslator.js` — React adapter; verify dispatch wiring with a smoke component |
| **Day 3 AM** | Rewrite `App.jsx` integration; wire DualVoiceButton + TextInputBar to dispatch FSM events |
| **Day 3 PM** | MediaRecorder integration for right path; mobile audio unlock; Safari fallback Audio element |
| **Day 4 AM** | Settings: STT vocabulary textarea; custom instructions textarea; force-reset button; status bar updates |
| **Day 4 PM** | forceReset full drain implementation; window-blur handler; Esc handler; auto-reset triggers |
| **Day 5 AM** | Eval harness: `evals/runEvals.mjs` + 20 translation cases + 10 FSM tests |
| **Day 5 PM** | Cross-browser smoke test; CEO walkthrough; iterate; tag `stable-v2.0` |

---

**End of spec. Implementation begins now.**
