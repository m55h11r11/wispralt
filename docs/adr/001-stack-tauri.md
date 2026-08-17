# ADR-001: Stay on Tauri (vs. forking VoiceInk / native Swift)

Date: 2026-06-10
Status: Accepted

## Context

`WISPR-CLONE-BLUEPRINT.md` (2026-05-30) recommended forking Beingpax/VoiceInk
(GPL-3.0, native Swift + AppKit/SwiftUI + MLX) as the fastest path to production
quality, citing: direct AVAudioEngine, ANE via CoreML, AXUIElement entitlements,
NSPanel collection behaviors, and CGEventTap for Fn-key push-to-talk. The app was
then built greenfield on Tauri v2 + React anyway, and no document revisited the
contradiction. Four handoffs later, the Tauri app has a working end-to-end
dictation loop and a pixel-matched UI, and the project is preparing to go public.

## Decision

**Stay on Tauri.** Going with Tauri because the working E2E app + pixel-matched
React UI is the project's largest sunk asset, and every blueprint "Swift-only"
blocker is reachable from Rust through the same C APIs — even though forking
VoiceInk is tempting for its prebuilt local engine, it would discard nearly all
shipped work and chain a public project to GPL-3.0.

## Ceiling mitigations (why the Swift-only blockers don't block)

1. **Fn-key PTT / CGEventTap** — CGEventTap is a C API; Rust calls it via
   `core-graphics`/`rdev` exactly as Swift does. When implemented, include the
   `kCGEventTapDisabledByTimeout` re-enable watchdog (blueprint risk #1).
2. **Local ASR** — MLX is Swift/Python-first, but `whisper.cpp` has Metal
   support with mature Rust bindings (`whisper-rs`); comparable on-device ASR
   performance behind the existing `src/lib/engine.ts` boundary.
3. **NSPanel behaviors** — reachable via `objc2` from Rust when needed;
   `macos-private-api` is already in use for the overlay window.

## Consequences

- The codebase stays MIT-licensable (no GPL contamination); VoiceInk may be read
  for *techniques* only — no code copied.
- Advanced native features cost more Rust work than they would cost in a Swift
  fork; accepted trade-off.
- WebView memory overhead (~100–200 MB) vs pure AppKit; accepted for v0.x.
- This ADR supersedes the blueprint's §7 "fork VoiceInk" recommendation.
