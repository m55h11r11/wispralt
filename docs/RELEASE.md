# Lirrly Release Runbook (signing + notarization)

One-time prerequisites — **DONE 2026-09-01** (kept for disaster recovery):

1. **Apple Developer Program** — enrolled; team `P7NJPZ5669` (meshari almansori).
2. **Developer ID Application certificate** — issued via the developer portal
   (G2 Sub-CA, expires 2031-09-02) from the CSR in `signing/`. The identity
   lives in a dedicated keychain `~/Library/Keychains/lirrly-sign.keychain-db`
   (password in `signing/keychain.pass`, gitignored), already on the user
   keychain search list with promptless codesign access. Verify with:
   ```bash
   security find-identity -v -p codesigning ~/Library/Keychains/lirrly-sign.keychain-db
   # → "Developer ID Application: meshari almansori (P7NJPZ5669)"
   ```
3. **Notarization credential** — App Store Connect **team API key**
   `lirrly-sign`, Key ID `XLT95RUR83`, Admin, Issuer
   `a471a2a7-86ad-4a5a-857f-55931318f801`; `.p8` at
   `signing/AuthKey_XLT95RUR83.p8` (gitignored; backup copy in ~/Downloads).
   Note: Developer ID **cert creation** is Account-Holder-only — team keys get
   403 from the API; use the portal UI (Certificates → add → Developer ID
   Application → G2 Sub-CA) if the cert ever needs reissuing.

## Per-release steps

**The whole release is one command:**

```bash
# 1. build, sign, notarize, commit, tag — stops at the provenance gate
./scripts/release.sh 0.4.2 --notes signing/release-notes-0.4.2.md
# 2. push the clean public cut for 0.4.2 to main (MASTER-HANDOFF.md)
# 3. publish, reusing the artifacts from step 1 — no rebuild
./scripts/release.sh 0.4.2 --notes signing/release-notes-0.4.2.md --publish-only
```

It refuses to run on a dirty tree, then bumps every version-bearing file (including
`package-lock.json`) and asserts they all agree, runs every gate — frontend, full Rust,
**the shared core crate**, and the architecture/IPC contract check — builds signed +
notarized, verifies Gatekeeper trust, generates `latest.json` for the auto-updater,
commits + tags, publishes the GitHub release with all four assets, and bumps the
Homebrew cask in `homebrew-lirrly/` before pushing the tap.

> **Push the clean public cut to `main` before the script publishes, not after.**
> The script now refuses to publish unless `origin/main` already declares the version
> being released, and it targets that exact commit rather than whatever `main` happens
> to be. This is what went wrong with v0.4.1: it was published with `--target main`
> before the public cut, so the public `v0.4.1` tag points at source still declaring
> 0.4.0. If the script stops at this gate, push the public cut and re-run — the signed
> artifacts are already built and are reused. See "Public pushes" in `MASTER-HANDOFF.md`.

### Updater signing (separate from Apple signing)

Updates are verified with our own minisign keypair, independent of Apple's Developer ID:
`signing/updater.key` (+ `signing/updater.pass`), public key committed in
`tauri.conf.json` under `plugins.updater.pubkey`.

> **Losing `signing/updater.key` breaks auto-updates permanently for every installed
> copy** — a new key can't sign updates the installed apps will accept, so every user
> would have to reinstall by hand. It is not recoverable from Apple or GitHub. Back it up.

Release assets that must be present for updates to work:
`Lirrly_<v>_aarch64.dmg`, `Lirrly_<v>_aarch64.app.tar.gz`, and `latest.json`
(pointing at the tarball, carrying the `.sig` contents).


## Lirrly Lite (Mac App Store)

Separate product, separate crate, separate keychain service — see
[ADR-005](adr/005-mac-app-store-lite.md).

```bash
./scripts/release-lite.sh            # build + sign + package, stop for inspection
./scripts/release-lite.sh --upload   # ... and upload to App Store Connect
```

It gates on the frontend build, clippy/fmt, and the core crate's tests, then verifies the
sandbox entitlements, the embedded provisioning profile and the Apple Distribution
signature before packaging. Uploads go through **Transporter**
(`/Applications/Transporter.app`) because `altool` no longer ships with Xcode.

App Store facts: app id `6807936071`, bundle `com.mshrmnsr.lirrly-lite`, provisioning
profile `signing/lirrly-lite.provisionprofile`. Metadata copy lives in
`docs/appstore/lirrly-lite-metadata.md`.

> A Mac-App-Store-provisioned build is SIGKILLed if launched outside the store — that is
> normal. For local smoke tests build with `--config src-tauri/tauri.localtest.conf.json`,
> which swaps in identical sandbox entitlements minus the App Store identifiers.

## Manual fallback

If the script fails partway, these are the same steps by hand:

```bash
cd lirrly

# 1. Bump versions (package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json)
#    — Account section shows it via getVersion() automatically.

# 2. Gates
npm run build && npm run lint && npm test
(cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check)

# 3. Signed + notarized build (signing config lives in tauri.conf.json:
#    hardenedRuntime + Lirrly.entitlements; identity/notary come from env)
export APPLE_SIGNING_IDENTITY="Developer ID Application: meshari almansori (P7NJPZ5669)"
export APPLE_API_ISSUER="a471a2a7-86ad-4a5a-857f-55931318f801"
export APPLE_API_KEY="XLT95RUR83"
export APPLE_API_KEY_PATH="$(git rev-parse --show-toplevel)/signing/AuthKey_XLT95RUR83.p8"
security unlock-keychain -p "$(cat ../signing/keychain.pass)" ~/Library/Keychains/lirrly-sign.keychain-db
npm run tauri build

# 4. Verify
codesign -dv --verbose=2 "src-tauri/target/release/bundle/macos/Lirrly.app"
spctl --assess --type exec -vv "src-tauri/target/release/bundle/macos/Lirrly.app"
# Staple lives on the .app, not the DMG: Tauri notarizes and staples the app,
# then builds and signs the DMG around it. Validating the DMG always reports
# "does not have a ticket stapled" — that is expected and matches every shipped
# release. The app inside is what Gatekeeper evaluates on launch.
xcrun stapler validate "src-tauri/target/release/bundle/macos/Lirrly.app"

# 5. Built-app smoke test (fresh user account or wiped state):
#    onboarding wizard → key validate → first dictation → paste lands;
#    keychain entry "com.mshrmnsr.lirrly / groq-api-key" exists;
#    no CSP violations in the webview console.

# 6. Tag + GitHub release with the DMG attached
git tag v<version> && git push origin v<version>
gh release create v<version> "src-tauri/target/release/bundle/dmg/Lirrly_<version>_aarch64.dmg" \
  --title "Lirrly <version>" --notes-file <notes>
```

Notes
- Unsigned local/dev builds keep working: without `APPLE_SIGNING_IDENTITY`,
  Tauri ad-hoc signs and skips notarization.
- The mic entitlement (`com.apple.security.device.audio-input`) is required
  under hardened runtime; Accessibility has no entitlement — users grant it in
  System Settings (the app preflights via `AXIsProcessTrusted`).
- Re-test the Keychain read/write in the **notarized** build before publishing
  (hardened runtime changes keychain behavior vs `tauri dev`).
