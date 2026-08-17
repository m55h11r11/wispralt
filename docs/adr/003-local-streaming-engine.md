# ADR-003: Local + streaming engine — whisper.cpp behind the engine boundary

Date: 2026-08-16
Status: Accepted (design; implementation targeted at v0.4)

## Context

[dimastatz/whisper-flow](https://github.com/dimastatz/whisper-flow) (MIT,
Python/FastAPI, ~884★) demonstrates real-time Whisper streaming: 16 kHz mono PCM
chunks → tumbling window (capped ~32 s) → re-transcribe the whole window each
cycle (local Whisper `tiny.en`, temp 0.1, logprob −0.5) → emit *partial*; when
consecutive cycles produce identical text → emit *final*, reset the window.
Measured ~275 ms mean inter-partial latency on an M1.

Lirrly today is batch cloud: whole-clip webm → Groq `whisper-large-v3-turbo`.
ADR-001 already reserves the local path: `whisper-rs` (whisper.cpp + Metal)
behind the `src/lib/engine.ts` boundary, and Settings ships a disabled "Local"
provider toggle.

## Decision

Adopt whisper-flow's **architecture concepts, not its code**: a native Rust
implementation with whisper-rs, staged S1→S4 below. Bundling whisper-flow as a
Python sidecar is rejected — hundreds of MB of runtime in the DMG, `tiny.en`
quality (English-first; Arabic is Lirrly's edge), and a fragile second process.

## Improvements over whisper-flow's loop (recorded now so v0.4 doesn't relearn them)

- **Finalization**: LocalAgreement-2 — commit the longest common prefix of
  consecutive hypotheses — instead of exact-full-repeat, which burns an extra
  silent cycle before every final and re-transcribes text that is already
  stable.
- **Segmentation**: VAD/energy-assisted silence close. whisper-flow's config
  defines `SILENCE_THRESHOLD` but the streaming loop never uses it; stability
  is its only segmentation signal.
- **Models**: two-tier — a small multilingual model for live partials, and
  `large-v3-turbo` (or the cloud engine, when online) for the committed final
  pass. Arabic quality must not regress.
- **Window cost**: cap the re-transcription window and carry committed text as
  the decode prompt for context continuity.

## Stages (v0.4)

- **S1 — PCM capture spike**: cpal (native capture, real device handling) vs
  AudioWorklet→IPC (stays in the webview, keeps MediaRecorder parity). Decide on
  measured IPC overhead and the device-selection migration cost (settings store
  webview `deviceId`s today; cpal identifies devices by name).
- **S2 — Local batch engine**: whisper-rs + Metal; GGUF model manager
  (download / verify / delete) in Settings; the "Local" provider toggle goes
  live; benchmark turbo-q8 latency on Apple Silicon (spike gate: verify
  whisper-rs Metal build health first).
- **S3 — Streaming loop**: ring buffer → ~1 s cadence window transcription →
  `partial-transcript` events → RTL-aware live caption in the FlowBar;
  LocalAgreement-2 commit + VAD close; instrument mean inter-partial latency
  (whisper-flow's own benchmark metric) so regressions are visible.
- **S4 — Final pass + pipeline reuse**: stop → full-buffer final transcription →
  the existing cleanup → snippets → paste path; per-engine fallback setting
  (local ↔ cloud).

## Risks

Active-memory footprint (0.6–1.5 GB with turbo resident), model-download UX,
webview IPC bandwidth (S1 decides the capture side), small-model Arabic partial
quality (S2 benchmarks before S3 commits to live captions).

## Credits

Streaming design informed by
[dimastatz/whisper-flow](https://github.com/dimastatz/whisper-flow) (MIT).
Concepts only — no code copied; acknowledged in `lirrly/NOTICE`.
