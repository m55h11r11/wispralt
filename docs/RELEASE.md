# Lirrly Release Runbook (signing + notarization)

One-time prerequisites (user actions):

1. **Apple Developer Program** — enroll at developer.apple.com ($99/year).
2. **Developer ID Application certificate** — Xcode → Settings → Accounts →
   Manage Certificates → "+" → *Developer ID Application*. Verify with:
   ```bash
   security find-identity -v -p codesigning
   # → "Developer ID Application: <Name> (<TEAMID>)"
   ```
3. **App-specific password** for notarization — appleid.apple.com → Sign-In &
   Security → App-Specific Passwords (or use an App Store Connect API key).

## Per-release steps

```bash
cd lirrly

# 1. Bump versions (package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json)
#    — Account section shows it via getVersion() automatically.

# 2. Gates
npm run build && npm run lint && npm test
(cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check)

# 3. Signed + notarized build (signing config lives in tauri.conf.json:
#    hardenedRuntime + Lirrly.entitlements; identity/notary come from env)
export APPLE_SIGNING_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="<TEAMID>"
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
