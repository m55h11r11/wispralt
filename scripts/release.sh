#!/usr/bin/env bash
# Lirrly release: build → sign → notarize → staple → publish → update the tap.
#
# Everything secret stays on this Mac: the Developer ID identity lives in a
# dedicated keychain and the notarization + updater keys live in ./signing
# (gitignored). Nothing is uploaded to CI.
#
#   ./scripts/release.sh 0.4.0 --notes path/to/notes.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/lirrly"
SIGNING="$ROOT/signing"
TAP="${LIRRLY_TAP:-$ROOT/homebrew-lirrly}"
REPO="m55h11r11/wispralt"
KEYCHAIN="$HOME/Library/Keychains/lirrly-sign.keychain-db"

VERSION="${1:-}"
NOTES=""
[ $# -ge 1 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --notes) NOTES="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release.sh <x.y.z> [--notes FILE]"

step "Preflight"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || die "working tree is dirty — commit or stash first"
for f in "$SIGNING/AuthKey_XLT95RUR83.p8" "$SIGNING/updater.key" "$SIGNING/updater.pass" "$SIGNING/keychain.pass"; do
  [ -f "$f" ] || die "missing signing material: $f"
done
[ -f "$KEYCHAIN" ] || die "signing keychain not found: $KEYCHAIN"
command -v gh >/dev/null || die "gh CLI not installed"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
[ -z "$(git -C "$ROOT" tag -l "v$VERSION")" ] || die "tag v$VERSION already exists"
echo "  ok — releasing v$VERSION"

step "Bumping version to $VERSION"
/usr/bin/sed -i '' "s/^version = \"[0-9.]*\"/version = \"$VERSION\"/" "$APP/src-tauri/Cargo.toml"
/usr/bin/sed -i '' "4s/\"version\": \"[0-9.]*\"/\"version\": \"$VERSION\"/" "$APP/package.json"
python3 - "$APP/src-tauri/tauri.conf.json" "$VERSION" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
with open(path) as fh:
    conf = json.load(fh)
conf["version"] = version
with open(path, "w") as fh:
    json.dump(conf, fh, indent=2)
    fh.write("\n")
PY

step "Gates"
(cd "$APP" && npm run lint && npm test && npm run build)
(cd "$APP/src-tauri" && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)

step "Signed + notarized build"
security unlock-keychain -p "$(cat "$SIGNING/keychain.pass")" "$KEYCHAIN"
cd "$APP"
APPLE_SIGNING_IDENTITY="Developer ID Application: meshari almansori (P7NJPZ5669)" \
APPLE_API_ISSUER="a471a2a7-86ad-4a5a-857f-55931318f801" \
APPLE_API_KEY="XLT95RUR83" \
APPLE_API_KEY_PATH="$SIGNING/AuthKey_XLT95RUR83.p8" \
TAURI_SIGNING_PRIVATE_KEY="$(cat "$SIGNING/updater.key")" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat "$SIGNING/updater.pass")" \
  npm run tauri build

BUNDLE="$APP/src-tauri/target/release/bundle"
DMG="$BUNDLE/dmg/Lirrly_${VERSION}_aarch64.dmg"
TARBALL="$BUNDLE/macos/Lirrly.app.tar.gz"
SIG="$TARBALL.sig"
for f in "$DMG" "$TARBALL" "$SIG"; do [ -f "$f" ] || die "expected artifact missing: $f"; done

step "Verifying Gatekeeper trust"
codesign --verify --deep --strict "$BUNDLE/macos/Lirrly.app"
# Capture first: `cmd | grep -q` would SIGPIPE cmd and trip `set -o pipefail`.
ASSESS="$(spctl --assess --type exec -vv "$BUNDLE/macos/Lirrly.app" 2>&1 || true)"
case "$ASSESS" in *"source=Notarized Developer ID"*) ;; *) die "app is not notarized" ;; esac
xcrun stapler validate "$BUNDLE/macos/Lirrly.app" >/dev/null || die "notarization ticket not stapled"
echo "  ok — notarized and stapled"

step "Staging release assets"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
ASSET_TARBALL="Lirrly_${VERSION}_aarch64.app.tar.gz"
cp "$DMG" "$OUT/"
cp "$TARBALL" "$OUT/$ASSET_TARBALL"
DMG_SHA="$(shasum -a 256 "$DMG" | awk '{print $1}')"
echo "$DMG_SHA  Lirrly_${VERSION}_aarch64.dmg" > "$OUT/Lirrly_${VERSION}_aarch64.dmg.sha256"

# latest.json is what installed copies poll; the signature is verified client-side.
python3 - "$OUT/latest.json" "$VERSION" "$SIG" \
  "https://github.com/$REPO/releases/download/v$VERSION/$ASSET_TARBALL" "$NOTES" <<'PY'
import json, sys, datetime
out, version, sig_path, url, notes_path = sys.argv[1:6]
notes = ""
if notes_path:
    with open(notes_path) as fh:
        notes = fh.read().strip()
with open(sig_path) as fh:
    signature = fh.read().strip()
manifest = {
    "version": version,
    "notes": notes or f"Lirrly {version}",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    "platforms": {"darwin-aarch64": {"signature": signature, "url": url}},
}
with open(out, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
PY

step "Committing and tagging"
git -C "$ROOT" add -A
git -C "$ROOT" commit -m "v$VERSION"
git -C "$ROOT" tag "v$VERSION"

step "Publishing GitHub release"
NOTES_ARGS=(--generate-notes)
[ -n "$NOTES" ] && NOTES_ARGS=(--notes-file "$NOTES")
gh release create "v$VERSION" \
  "$OUT/Lirrly_${VERSION}_aarch64.dmg" \
  "$OUT/$ASSET_TARBALL" \
  "$OUT/Lirrly_${VERSION}_aarch64.dmg.sha256" \
  "$OUT/latest.json" \
  --repo "$REPO" --target main --title "Lirrly $VERSION" --latest "${NOTES_ARGS[@]}"

step "Updating Homebrew tap"
if [ -d "$TAP/.git" ]; then
  /usr/bin/sed -i '' "s/  version \".*\"/  version \"$VERSION\"/" "$TAP/Casks/lirrly.rb"
  /usr/bin/sed -i '' "s/  sha256 \".*\"/  sha256 \"$DMG_SHA\"/" "$TAP/Casks/lirrly.rb"
  git -C "$TAP" add -A
  git -C "$TAP" commit -m "lirrly $VERSION" || true
  git -C "$TAP" push
  echo "  ok — tap updated to $VERSION"
else
  echo "  skipped — no tap checkout at $TAP"
fi

echo
echo "✓ Lirrly $VERSION released"
echo "  https://github.com/$REPO/releases/tag/v$VERSION"
echo "  Remember: push the public clean-cut commit to main (see docs/RELEASE.md)."
