# ADR-005: A sandboxed "Lirrly Lite" for the Mac App Store

- **Status:** Accepted (packaging proven, submission not yet started)
- **Date:** 2026-09-02
- **Supersedes:** nothing. **Amends:** [ADR-002](002-distribution-developer-id-not-mas.md)

## Context

ADR-002 concluded that Lirrly cannot ship on the Mac App Store, and that remains
true **for the full app**: it needs `macOSPrivateApi` for the transparent FlowBar,
Accessibility for reading the selection, and synthetic ⌘V to paste into other apps.
All three are disqualifying — the first two are incompatible with the mandatory App
Sandbox, and the third is rejected under Guideline 2.4.5.

The owner nonetheless wants App Store presence as a discovery channel. The only honest
way to have both is a **second, deliberately reduced product** that is App-Store-legal
on its own terms, while the full app continues as a notarized direct download.

## Decision

Ship **Lirrly Lite**: a sandboxed, in-window dictation app.

- **Free**, BYO Groq API key (owner's decision, 2026-09-02).
- Apple Silicon only, matching the main app.
- **In scope:** record → transcribe → cleanup → *Copy*, transforms applied in-window,
  local history, BYO-key setup.
- **Out of scope (sandbox-incompatible or gratuitous):** global hotkeys, paste-at-cursor,
  Accessibility, autostart LaunchAgent, the transparent FlowBar, tray-only mode, and the
  self-updater — App Store builds must update only through the store.

Shared logic (Groq calls and, critically, the Arabic dialect-preserving prompt) is to be
extracted into a `lirrly-core` crate so the prompt lives in exactly one place, rather
than duplicating it or scattering `#[cfg]` branches through the main app.

## Licensing — the part that is not optional

AGPL-3.0 is incompatible with App Store distribution: the store imposes usage
restrictions that the GPL family forbids adding (the VLC precedent). This is survivable
only because **mshrmnsr is the sole copyright holder** — `git log` shows exactly one
author — so the same code can be offered under separate proprietary terms for the store
build, exactly as [ADR-004](004-licensing-agpl-and-monetization.md) anticipated.
`CONTRIBUTING.md` already carries the relicensing grant that keeps this true if outside
contributions ever land.

Consequence: **Lirrly Lite ships under proprietary terms, not AGPL**, and every bundled
dependency must be permissive (MIT/Apache). One copyleft dependency would make store
distribution impossible.

## Gate 0 result — packaging is proven (2026-09-02)

Rather than build Lite first and discover packaging problems later, the packaging path
was proven end to end with a spike build:

| Step | Result |
|---|---|
| App ID `com.mshrmnsr.lirrly-lite` | created via App Store Connect API |
| Mac Installer Distribution certificate | already present in the login keychain |
| Mac App Store provisioning profile | created via API → `signing/lirrly-lite.provisionprofile` |
| Sandboxed `.app` (Tauri, `macOSPrivateApi: false`) | builds and signs with **Apple Distribution** |
| Entitlements on the signed binary | `app-sandbox`, `device.audio-input`, `network.client`, `application-identifier`, `team-identifier`, `keychain-access-groups` — all verified present |
| `embedded.provisionprofile` | embedded in the bundle |
| Signed `.pkg` via `productbuild` | built; chain verified with `pkgutil --check-signature` |
| App Store Connect app record | **created** — "Lirrly Lite", app id `6807936071`, SKU `LIRRLYLITE001`, macOS, en-US |
| Upload to App Store Connect | **succeeded** via Transporter (`altool` no longer ships with Xcode) |
| Apple's automated processing | **`processingState: VALID`** — the sandboxed Tauri binary passes Apple's validation |

The harness lives in `lirrly/src-tauri/tauri.mas.conf.json` +
`lirrly/src-tauri/LirrlyLite.entitlements`.

> ⚠️ That config currently repackages the **full** app as a proof of the packaging path.
> It is not submittable: the feature-stripping and `lirrly-core` extraction above must
> land first.

### Gotcha found during the spike (drives the architecture)

Building with `--config tauri.mas.conf.json` **rewrote the shared `Cargo.toml`**: Tauri's
build script syncs Cargo features to the active config, so `macOSPrivateApi: false`
silently deleted `macos-private-api` from the `tauri` dependency. The next ordinary build
of the main app would have shipped without the transparent FlowBar.

This settles the architecture question: Lite must be **its own crate with its own
`Cargo.toml`**, not a config override over the main app's crate. An override mutates
shared state and will eventually ship a broken main build.

The app record had to be created by hand in the web UI — Apple's API refuses it
(`403 — The resource 'apps' does not allow 'CREATE'`). That is done. **The full pipeline
from source to an accepted App Store Connect build is now proven.**

> 🛑 **The uploaded build must never be submitted for review.** It is the spike: the full
> app repackaged as sandboxed. It passed *automated* processing because the private-API
> Cargo feature was compiled out, but it still contains the Accessibility and synthetic-paste
> code paths, which do nothing under the sandbox. Submitting it would earn a deserved
> rejection. Replace it with the real Lite build first.

Remaining work is ordinary product work, not unknowns: extract `lirrly-core`, build Lite as
its own crate, then App Store Connect metadata (description, keywords, screenshots at
1280×800, age rating, privacy questionnaire pointing at https://lirrly.com/privacy.html,
and a demo Groq key in the App Review notes).

## Consequences

- Two products, one core. The full app stays AGPL and direct-download; Lite is the store
  funnel under separate terms.
- Store review may still reject Lite under Guideline 4.2 (minimum functionality) or over
  the BYO-key requirement. Mitigation: a working demo Groq key in the App Review notes —
  a reviewer who cannot use the app will reject it. Budget 1–2 review cycles.
- The funnel stays modest: one "More at lirrly.com" link. Anything harder reads as using
  the store to advertise off-store distribution.
