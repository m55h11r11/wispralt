# ADR-002: Distribute via Developer ID + notarization, not the Mac App Store

Date: 2026-08-16
Status: Accepted

## Context

Lirrly is release-ready pending Apple signing. The open question was whether to
enroll and ship through the Mac App Store or distribute directly (notarized DMG).
Both paths require the same Apple Developer Program membership ($99/yr), so the
question is purely about the channel, not the cost.

## Decision

**Enroll in the Apple Developer Program and distribute OUTSIDE the Mac App
Store**: Developer ID-signed, notarized DMG on GitHub Releases; Homebrew cask
later; `tauri-plugin-updater` for updates (targeted v0.3.x).

## Why MAS is closed to Lirrly

1. **Private API**: `macOSPrivateApi: true` (tauri.conf.json) powers the
   transparent FlowBar overlay. Private API use is an automatic App Store
   rejection.
2. **Sandbox**: MAS requires App Sandbox; the Accessibility-gated APIs Lirrly
   preflights (`AXIsProcessTrusted` via macos-accessibility-client) are
   documented by Apple engineers as incompatible with sandboxing
   (developer.apple.com/forums threads 756130, 780626).
3. **Guideline 2.4.5**: the core UX — synthetic ⌘V/⌘C via enigo (CGEvent) — is
   rejected in practice as "non-accessibility use of accessibility features"
   even where the PostEvent privilege is technically sandbox-compatible
   (clipboard-manager rejection precedent, forum thread 820594).
4. **Market signal**: Wispr Flow, superwhisper, VoiceInk, and MacWhisper (full)
   all distribute direct. No serious system-wide dictation app ships on MAS.

## Consequences

- Gatekeeper trust comes from notarization (docs/RELEASE.md runbook); no store
  review latency and no 2.4.5 roulette.
- Discovery happens via GitHub / Homebrew / communities instead of MAS search —
  acceptable for a free, open-source tool.
- Updates are our responsibility → `tauri-plugin-updater` is the next
  distribution work item (the Settings "App updates" badge stays honest until
  then).

## Revisit if

Apple ships sandbox-compatible system-wide text insertion, or a deliberately
crippled "file transcription only" MAS companion ever justifies its
maintenance cost.
