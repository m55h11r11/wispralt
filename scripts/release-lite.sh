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
# Strict on purpose: `--uplaod` silently building-without-uploading is how a
# release step gets skipped without anyone noticing (audit A31).
for arg in "$@"; do
  case "$arg" in
    --upload) UPLOAD=1 ;;
    *) echo "✗ unknown argument: $arg (only --upload is accepted)" >&2; exit 1 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }

step "Preflight"
[ -f "$SIGNING/lirrly-lite.provisionprofile" ] || die "missing provisioning profile"
[ -f "$SIGNING/AuthKey_$API_KEY.p8" ] || die "missing App Store Connect API key"
IDENTITIES="$(security find-identity -v 2>/dev/null || true)"
case "$IDENTITIES" in *"$PKG_IDENTITY"*) ;; *) die "installer identity not in keychain" ;; esac
[ -x "$TRANSPORTER" ] || die "Transporter not installed (altool no longer ships with Xcode)"
echo "  ok"

step "Verifying every version-bearing file agrees"
python3 - "$LITE" <<'VERSIONS'
import json, pathlib, re, sys
lite = pathlib.Path(sys.argv[1])
lock = json.loads((lite / "package-lock.json").read_text())
found = {
    "package.json": json.loads((lite / "package.json").read_text())["version"],
    "package-lock.json": lock["version"],
    "package-lock.json (root package)": lock["packages"][""]["version"],
    "Cargo.toml": re.search(r'^version = "([^"]+)"', (lite / "src-tauri/Cargo.toml").read_text(), re.M).group(1),
    "tauri.conf.json": json.loads((lite / "src-tauri/tauri.conf.json").read_text())["version"],
}
if len(set(found.values())) != 1:
    for k, v in found.items():
        print(f"  {k} says {v}", file=sys.stderr)
    raise SystemExit(1)
print(f"  ok — {len(found)} files all say {next(iter(found.values()))}")
VERSIONS

step "Gates"
(cd "$LITE" && npm run lint && npm test && npm run build)
(cd "$LITE/src-tauri" && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
(cd "$ROOT/crates/lirrly-core" && cargo test)

step "Sandboxed, signed build"
security unlock-keychain -p "$(cat "$SIGNING/keychain.pass")" "$KEYCHAIN"
(cd "$LITE" && APPLE_SIGNING_IDENTITY="$APP_IDENTITY" npm run tauri build -- --bundles app)

APP="$LITE/src-tauri/target/release/bundle/macos/Lirrly Lite.app"
[ -d "$APP" ] || die "app bundle not produced"

step "Verifying sandbox + signature"
codesign --verify --deep --strict "$APP" || die "signature invalid"
# Values, not key names: a grep for the *name* passed even if the sandbox was
# <false/> or the identifier pointed at another app (audit A31).
ENTS_FILE="$(mktemp)"
codesign -d --entitlements - --xml "$APP" 2>/dev/null > "$ENTS_FILE" || die "could not read entitlements"
python3 - "$ENTS_FILE" <<'ENTITLEMENTS' || die "entitlement values wrong"
import plistlib, sys
with open(sys.argv[1], "rb") as fh:
    ents = plistlib.load(fh)
expected = {
    "com.apple.security.app-sandbox": True,
    "com.apple.security.device.audio-input": True,
    "com.apple.security.network.client": True,
    "com.apple.application-identifier": "P7NJPZ5669.com.mshrmnsr.lirrly-lite",
    "com.apple.developer.team-identifier": "P7NJPZ5669",
    "keychain-access-groups": ["P7NJPZ5669.com.mshrmnsr.lirrly-lite"],
}
bad = {k: ents.get(k) for k, v in expected.items() if ents.get(k) != v}
if bad:
    for k, v in bad.items():
        print(f"  ✗ entitlement {k} = {v!r}", file=sys.stderr)
    raise SystemExit(1)
print(f"  ok — {len(expected)} entitlement values verified")
ENTITLEMENTS
rm -f "$ENTS_FILE"
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
