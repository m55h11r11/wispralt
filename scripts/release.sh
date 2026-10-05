#!/usr/bin/env bash
# Lirrly release: build → sign → notarize → staple → publish → update the tap.
#
# Everything secret stays on this Mac: the Developer ID identity lives in a
# dedicated keychain and the notarization + updater keys live in ./signing
# (gitignored). Nothing is uploaded to CI.
#
#   ./scripts/release.sh 0.4.0 --notes path/to/notes.md
#
# A release tag must point at public source that declares its own version, so
# publishing happens in two phases:
#
#   1. ./scripts/release.sh 0.4.0 --notes notes.md   # bump → gates → sign →
#                                                    # notarize → commit → tag,
#                                                    # then stop at the
#                                                    # provenance gate
#   2. push the clean public cut for 0.4.0 to main   # see MASTER-HANDOFF.md
#   3. ./scripts/release.sh 0.4.0 --publish-only     # gate passes → publish
#
# Phase 3 reuses the artifacts phase 1 already signed and notarized; it never
# rebuilds, so the published binary is exactly the one that was verified.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$ROOT/lirrly"
SIGNING="$ROOT/signing"
TAP="${LIRRLY_TAP:-$ROOT/homebrew-lirrly}"
REPO="m55h11r11/wispralt"
KEYCHAIN="$HOME/Library/Keychains/lirrly-sign.keychain-db"

VERSION="${1:-}"
NOTES=""
PUBLISH_ONLY=0
[ $# -ge 1 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    # Resolve now: later steps run from other directories.
    --notes) NOTES="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    --publish-only) PUBLISH_ONLY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "▸ $*"; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "usage: release.sh <x.y.z> [--notes FILE] [--publish-only]"

step "Preflight"
[ -z "$(git -C "$ROOT" status --porcelain)" ] || die "working tree is dirty — commit or stash first"
for f in "$SIGNING/AuthKey_XLT95RUR83.p8" "$SIGNING/updater.key" "$SIGNING/updater.pass" "$SIGNING/keychain.pass"; do
  [ -f "$f" ] || die "missing signing material: $f"
done
[ -f "$KEYCHAIN" ] || die "signing keychain not found: $KEYCHAIN"
command -v gh >/dev/null || die "gh CLI not installed"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"
if [ "$PUBLISH_ONLY" = 1 ]; then
  [ -n "$(git -C "$ROOT" tag -l "v$VERSION")" ] || die "no local tag v$VERSION — run the build phase first"
  gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1 \
    && die "release v$VERSION already exists (maybe a draft from an aborted run — check: gh release view v$VERSION)"
  echo "  ok — publishing already-built v$VERSION"
else
  [ -z "$(git -C "$ROOT" tag -l "v$VERSION")" ] || die "tag v$VERSION already exists — did you mean --publish-only?"
  # Prove the tree is reviewed *before* the bump. After it, the drift check can
  # never pass — the bump rewrites five reviewed files by construction — so this
  # is the only point where the result means anything. Passing here is also what
  # makes the post-bump re-stamp below honest: the only possible drift left is
  # the version itself.
  python3 "$ROOT/scripts/architecture.py" --check \
    || die "architecture/IPC check failed — fix and review before releasing"
  echo "  ok — releasing v$VERSION"
fi

if [ "$PUBLISH_ONLY" = 0 ]; then

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
# package-lock.json carries the version twice; regenerate rather than sed it.
(cd "$APP" && npm install --package-lock-only --silent)

step "Verifying every version-bearing file agrees"
python3 - "$APP" "$VERSION" <<'PY'
import json, pathlib, re, sys
app, version = pathlib.Path(sys.argv[1]), sys.argv[2]
lock = json.loads((app / "package-lock.json").read_text())
found = {
    "package.json": json.loads((app / "package.json").read_text())["version"],
    "package-lock.json": lock["version"],
    "package-lock.json (root package)": lock["packages"][""]["version"],
    "Cargo.toml": re.search(r'^version = "([^"]+)"', (app / "src-tauri/Cargo.toml").read_text(), re.M).group(1),
    "tauri.conf.json": json.loads((app / "src-tauri/tauri.conf.json").read_text())["version"],
}
wrong = {k: v for k, v in found.items() if v != version}
if wrong:
    for k, v in wrong.items():
        print(f"  {k} says {v}, expected {version}", file=sys.stderr)
    raise SystemExit(1)
print(f"  ok — {len(found)} files all say {version}")
PY

step "Gates"
(cd "$APP" && npm run lint && npm test && npm run build)
(cd "$APP/src-tauri" && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
# The shared core is a path dependency: checking the app does not run its tests.
(cd "$ROOT/crates/lirrly-core" && cargo test)
# The full drift check already ran in preflight, before the bump made it
# unpassable. Re-stamp the inventory so the version table in ARCHITECTURE.md
# matches what is about to ship, and refuse if anything beyond the version
# files moved — that would mean unreviewed source is riding along.
python3 "$ROOT/scripts/architecture.py" --refresh >/dev/null
python3 "$ROOT/scripts/architecture.py" --reviewed >/dev/null
UNEXPECTED="$(git -C "$ROOT" diff --name-only \
  -- . ':(exclude)ARCHITECTURE.md' \
     ':(exclude)lirrly/package.json' ':(exclude)lirrly/package-lock.json' \
     ':(exclude)lirrly/src-tauri/Cargo.toml' ':(exclude)lirrly/src-tauri/Cargo.lock' \
     ':(exclude)lirrly/src-tauri/tauri.conf.json')"
[ -z "$UNEXPECTED" ] || die "the bump touched files it should not have:
$UNEXPECTED"

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

fi  # end build phase

BUNDLE="$APP/src-tauri/target/release/bundle"
DMG="$BUNDLE/dmg/Lirrly_${VERSION}_aarch64.dmg"
TARBALL="$BUNDLE/macos/Lirrly.app.tar.gz"
SIG="$TARBALL.sig"
for f in "$DMG" "$TARBALL" "$SIG"; do
  [ -f "$f" ] || die "expected artifact missing: $f${PUBLISH_ONLY:+ (rebuild: drop --publish-only)}"
done

step "Verifying Gatekeeper trust"
codesign --verify --deep --strict "$BUNDLE/macos/Lirrly.app"
# Capture first: `cmd | grep -q` would SIGPIPE cmd and trip `set -o pipefail`.
ASSESS="$(spctl --assess --type exec -vv "$BUNDLE/macos/Lirrly.app" 2>&1 || true)"
case "$ASSESS" in *"source=Notarized Developer ID"*) ;; *) die "app is not notarized" ;; esac
xcrun stapler validate "$BUNDLE/macos/Lirrly.app" >/dev/null || die "notarization ticket not stapled"
echo "  ok — notarized and stapled"

step "Binding the artifacts to this build"
# The archive's name carries no version, so a second build between the two
# phases (a test variant, say) used to be uploaded and signed into latest.json
# as this version (audit A43). Phase 1 records exactly what it verified;
# --publish-only refuses anything that is not byte-identical to it.
PLIST_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$BUNDLE/macos/Lirrly.app/Contents/Info.plist")"
[ "$PLIST_VERSION" = "$VERSION" ] || die "the built app says $PLIST_VERSION, not $VERSION — stale artifacts?"
MANIFEST="$BUNDLE/release-manifest.json"
CURRENT="$(python3 - "$VERSION" "$DMG" "$TARBALL" "$SIG" <<'PY'
import hashlib, json, sys
version, dmg, archive, signature = sys.argv[1:5]
def sha(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()
print(json.dumps({"version": version, "dmg": sha(dmg), "archive": sha(archive), "signature": sha(signature)}, sort_keys=True))
PY
)"
if [ "$PUBLISH_ONLY" = 0 ]; then
  echo "$CURRENT" > "$MANIFEST"
  echo "  ok — recorded $MANIFEST"
else
  [ -f "$MANIFEST" ] || die "no build manifest at $MANIFEST — rebuild (drop --publish-only)"
  [ "$(cat "$MANIFEST")" = "$CURRENT" ] \
    || die "the artifacts changed since phase 1 verified them (another build ran?) — rebuild (drop --publish-only)"
  echo "  ok — byte-identical to what phase 1 built and notarized"
fi

step "Staging release assets"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
ASSET_TARBALL="Lirrly_${VERSION}_aarch64.app.tar.gz"
cp "$DMG" "$OUT/"
# The same DMG under a name that never changes, so the website's Download
# button can link releases/latest/download/Lirrly.dmg and start the download
# in one click instead of opening the release page (audit A46).
cp "$DMG" "$OUT/Lirrly.dmg"
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

if [ "$PUBLISH_ONLY" = 0 ]; then

step "Committing and tagging"
# Explicit paths, never `git add -A`: automation tooling drops stray files into
# the repo root, and a sweeping add once staged a live API key.
git -C "$ROOT" add \
  ARCHITECTURE.md \
  lirrly/package.json \
  lirrly/package-lock.json \
  lirrly/src-tauri/Cargo.toml \
  lirrly/src-tauri/Cargo.lock \
  lirrly/src-tauri/tauri.conf.json
[ -z "$(git -C "$ROOT" diff --cached --name-only --diff-filter=A)" ] || \
  die "the bump staged a file that did not exist before — check git status"
git -C "$ROOT" commit -m "v$VERSION"
git -C "$ROOT" tag "v$VERSION"

fi  # end commit phase

step "Verifying public source provenance"
# A release tag must point at source that declares its own version. Publishing
# with `--target main` before the clean public cut is pushed is how v0.4.1 came
# to point at source still saying 0.4.0.
git -C "$ROOT" fetch --quiet origin main
PUBLIC_SHA="$(git -C "$ROOT" rev-parse origin/main)"
PUBLIC_VERSION="$(git -C "$ROOT" show "origin/main:lirrly/package.json" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])')"
if [ "$PUBLIC_VERSION" != "$VERSION" ]; then
  die "origin/main declares $PUBLIC_VERSION, not $VERSION.

  Everything is built, signed, notarized, committed and tagged locally — only
  publishing is blocked. Push the clean public cut for $VERSION to main (see
  \"Public pushes\" in MASTER-HANDOFF.md), then finish with:

      ./scripts/release.sh $VERSION${NOTES:+ --notes \"$NOTES\"} --publish-only

  That reuses these exact artifacts; it does not rebuild."
fi
echo "  ok — origin/main $(git -C "$ROOT" rev-parse --short origin/main) declares $VERSION"

step "Uploading GitHub release (draft)"
NOTES_ARGS=(--generate-notes)
[ -n "$NOTES" ] && NOTES_ARGS=(--notes-file "$NOTES")
# Draft first (A31): the assets upload while nothing is public, and the
# updater's `releases/latest` keeps serving the previous version. A failure
# anywhere before "Going live" leaves every channel exactly as it was.
gh release create "v$VERSION" \
  "$OUT/Lirrly_${VERSION}_aarch64.dmg" \
  "$OUT/Lirrly.dmg" \
  "$OUT/$ASSET_TARBALL" \
  "$OUT/Lirrly_${VERSION}_aarch64.dmg.sha256" \
  "$OUT/latest.json" \
  --repo "$REPO" --target "$PUBLIC_SHA" --title "Lirrly $VERSION" --draft "${NOTES_ARGS[@]}"

step "Preparing Homebrew tap"
TAP_READY=0
if [ -d "$TAP/.git" ]; then
  /usr/bin/sed -i '' "s/  version \".*\"/  version \"$VERSION\"/" "$TAP/Casks/lirrly.rb"
  /usr/bin/sed -i '' "s/  sha256 \".*\"/  sha256 \"$DMG_SHA\"/" "$TAP/Casks/lirrly.rb"
  grep -q "  version \"$VERSION\"" "$TAP/Casks/lirrly.rb" && grep -q "  sha256 \"$DMG_SHA\"" "$TAP/Casks/lirrly.rb" \
    || die "the cask did not take version $VERSION / sha256 $DMG_SHA — nothing is public yet; fix $TAP/Casks/lirrly.rb"
  git -C "$TAP" add Casks/lirrly.rb
  # `commit || true` used to turn any failure (a hook, a lock) into "ready",
  # leaving brew on the old version while GitHub went live (A43). Only an
  # already-committed cask — a re-run — may skip the commit.
  if git -C "$TAP" diff --cached --quiet; then
    echo "  cask already committed at $VERSION"
  else
    git -C "$TAP" commit -m "lirrly $VERSION" \
      || die "tap commit failed — nothing is public yet; the draft v$VERSION can be deleted and this re-run"
  fi
  TAP_READY=1
  echo "  ok — tap commit ready; pushed the moment the release is live"
else
  echo "  skipped — no tap checkout at $TAP"
fi

step "Going live"
# The one public step, last: flip the draft to published-and-latest, then let
# brew follow immediately. The cask URL 404s while the release is a draft,
# which is why the tap push must come after this flip, never before.
gh release edit "v$VERSION" --repo "$REPO" --draft=false --latest
if [ "$TAP_READY" = 1 ]; then
  git -C "$TAP" push \
    || die "release v$VERSION is LIVE but the tap push failed — finish it by hand: git -C '$TAP' push"
  echo "  ok — tap updated to $VERSION"
fi

echo
echo "✓ Lirrly $VERSION released"
echo "  https://github.com/$REPO/releases/tag/v$VERSION"
echo "  Tag points at public commit $(git -C "$ROOT" rev-parse --short origin/main)."
