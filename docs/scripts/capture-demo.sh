#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_REAL="$(cd "$ROOT" && pwd -P)"
APP_DIR="$ROOT/lirrly"
BASE_URL="${LIRRLY_CAPTURE_BASE_URL:-http://127.0.0.1:1420}"
ALLOW_REMOTE=0
if [[ "${1:-}" == "--allow-remote" ]]; then
  ALLOW_REMOTE=1
  shift
fi
OUT_INPUT="${1:-$ROOT/docs/screenshots/lirrly-demo.gif}"
OUT="$(
  ROOT_REAL="$ROOT_REAL" OUT_INPUT="$OUT_INPUT" node --input-type=module <<'NODE'
import path from "node:path";

const root = process.env.ROOT_REAL;
const input = process.env.OUT_INPUT;
const resolved = path.resolve(input);
const relative = path.relative(root, resolved);

if (relative.startsWith("..") || path.isAbsolute(relative)) {
  console.error(`Output path must stay inside project root: ${root}`);
  process.exit(1);
}

console.log(resolved);
NODE
)"
TMP_DIR="$ROOT_REAL/.tmp/capture-demo-$$"
SERVER_PID=""

mkdir -p "$(dirname "$OUT")"

if [[ "$ALLOW_REMOTE" != "1" ]]; then
  BASE_URL="$BASE_URL" node --input-type=module <<'NODE'
const raw = process.env.BASE_URL;
let url;
try {
  url = new URL(raw);
} catch {
  console.error(`Invalid capture URL: ${raw}`);
  process.exit(1);
}
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback.has(url.hostname)) {
  console.error(`Refusing to capture non-loopback URL without --allow-remote: ${raw}`);
  process.exit(1);
}
NODE
fi

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$TMP_DIR"

if ! curl -fsS "$BASE_URL" >/dev/null 2>&1; then
  (
    cd "$APP_DIR"
    npm run dev -- --host 127.0.0.1
  ) >"$TMP_DIR/vite.log" 2>&1 &
  SERVER_PID="$!"

  for _ in {1..60}; do
    if curl -fsS "$BASE_URL" >/dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
fi

if ! curl -fsS "$BASE_URL" >/dev/null 2>&1; then
  echo "Vite dev server did not become reachable at $BASE_URL" >&2
  [[ -f "$TMP_DIR/vite.log" ]] && cat "$TMP_DIR/vite.log" >&2
  exit 1
fi

WEBM_PATH="$(
  cd "$APP_DIR"
  LIRRLY_CAPTURE_BASE_URL="$BASE_URL" LIRRLY_CAPTURE_TMP="$TMP_DIR" node --input-type=module <<'NODE'
import { chromium } from "playwright";

const baseUrl = process.env.LIRRLY_CAPTURE_BASE_URL;
const videoDir = process.env.LIRRLY_CAPTURE_TMP;

async function launchBrowser() {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return chromium.launch({ channel: "chrome", headless: true });
  }
}

let browser;
let context;
let videoPath;

try {
  browser = await launchBrowser();
  context = await browser.newContext({
    viewport: { width: 600, height: 280 },
    deviceScaleFactor: 2,
    recordVideo: { dir: videoDir, size: { width: 600, height: 280 } },
  });
  const page = await context.newPage();

  const states = [
    "/?view=flowbar&open=1",
    "/?view=flowbar&menu=language&open=1",
    "/?view=flowbar&state=listening",
    "/?view=flowbar&state=processing",
    "/?view=flowbar&state=done",
  ];

  for (const path of states) {
    await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(path.includes("done") ? 900 : 700);
  }

  const video = page.video();
  await context.close();
  context = undefined;
  if (!video) throw new Error("No Playwright video was recorded");
  videoPath = await video.path();
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

console.log(videoPath);
NODE
)"

ffmpeg -y -i "$WEBM_PATH" -vf "fps=20,scale=600:-1:flags=lanczos,palettegen" "$TMP_DIR/palette.png" >/dev/null 2>&1
ffmpeg -y -i "$WEBM_PATH" -i "$TMP_DIR/palette.png" -filter_complex "fps=20,scale=600:-1:flags=lanczos[x];[x][1:v]paletteuse" "$OUT" >/dev/null 2>&1

echo "Wrote $OUT"
