#!/usr/bin/env bash
# Lirrly Lite → Mac App Store: build sandboxed, sign, package, upload.
#
#   ./scripts/release-lite.sh [--upload]
#
# Without --upload it stops after producing a signed .pkg so you can inspect it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LITE="$ROOT/lirrly-lite"
SIGNING="$ROOT/signing"
KEYCHAIN="$HOME/Library/Keychains/lirrly-sign.keychain-db"
APP_IDENTITY="Apple Distribution: meshari almansori (P7NJPZ5669)"
PKG_IDENTITY="3rd Party Mac Developer Installer: meshari almansori (P7NJPZ5669)"
API_KEY="XLT95RUR83"
API_ISSUER="a471a2a7-86ad-4a5a-857f-55931318f801"
TRANSPORTER="/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter"

UPLOAD=0
[ "${1:-}" = "--upload" ] && UPLOAD=1

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }

step "Preflight"
[ -f "$SIGNING/lirrly-lite.provisionprofile" ] || die "missing provisioning profile"
[ -f "$SIGNING/AuthKey_$API_KEY.p8" ] || die "missing App Store Connect API key"
IDENTITIES="$(security find-identity -v 2>/dev/null || true)"
case "$IDENTITIES" in *"$PKG_IDENTITY"*) ;; *) die "installer identity not in keychain" ;; esac
[ -x "$TRANSPORTER" ] || die "Transporter not installed (altool no longer ships with Xcode)"
echo "  ok"

step "Gates"
(cd "$LITE" && npm run build)
(cd "$LITE/src-tauri" && cargo fmt --check && cargo clippy --all-targets -- -D warnings)
(cd "$ROOT/crates/lirrly-core" && cargo test)

step "Sandboxed, signed build"
security unlock-keychain -p "$(cat "$SIGNING/keychain.pass")" "$KEYCHAIN"
(cd "$LITE" && APPLE_SIGNING_IDENTITY="$APP_IDENTITY" npm run tauri build -- --bundles app)

APP="$LITE/src-tauri/target/release/bundle/macos/Lirrly Lite.app"
[ -d "$APP" ] || die "app bundle not produced"

step "Verifying sandbox + signature"
codesign --verify --deep --strict "$APP" || die "signature invalid"
ENTS="$(codesign -d --entitlements - --xml "$APP" 2>/dev/null | plutil -convert xml1 -o - -)"
for key in com.apple.security.app-sandbox com.apple.security.device.audio-input com.apple.security.network.client com.apple.application-identifier; do
  echo "$ENTS" | grep -q "$key" || die "missing entitlement: $key"
done
[ -f "$APP/Contents/embedded.provisionprofile" ] || die "provisioning profile not embedded"
# Capture first: `cmd | grep -q` would SIGPIPE cmd and trip `set -o pipefail`.
SIGINFO="$(codesign -dv --verbose=2 "$APP" 2>&1)"
case "$SIGINFO" in *"Apple Distribution"*) ;; *) die "not signed with Apple Distribution" ;; esac
echo "  ok — sandboxed, signed, profile embedded"

step "Building signed .pkg"
PKG="$(mktemp -d)/LirrlyLite.pkg"
xcrun productbuild --sign "$PKG_IDENTITY" --component "$APP" /Applications "$PKG"
pkgutil --check-signature "$PKG" >/dev/null || die "pkg signature invalid"
echo "  $PKG"

if [ "$UPLOAD" -eq 1 ]; then
  step "Uploading to App Store Connect"
  "$TRANSPORTER" -m upload -assetFile "$PKG" -apiKey "$API_KEY" -apiIssuer "$API_ISSUER" -v informational
  echo
  echo "✓ uploaded — watch processing in App Store Connect (or via signing/asc_api.py)."
else
  echo
  echo "✓ built and signed. Re-run with --upload to send it to App Store Connect."
fi
