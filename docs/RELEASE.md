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
./scripts/release.sh 0.4.1 --notes signing/release-notes-0.4.1.md
```

It refuses to run on a dirty tree, then bumps all three version files, runs every gate,
builds signed + notarized, verifies Gatekeeper trust, generates `latest.json` for the
auto-updater, commits + tags, publishes the GitHub release with all four assets, and
bumps the Homebrew cask in `homebrew-lirrly/` before pushing the tap.

Afterwards, push the clean public cut to `main` (private dev docs excluded) — see
"Public pushes" in `MASTER-HANDOFF.md`.

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
xcrun stapler validate "src-tauri/target/release/bundle/dmg/Lirrly_<version>_aarch64.dmg"

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
