#!/usr/bin/env bash
# Packaged-build sanity check (plan/launch-v1.md, overnight item 8).
#
# Packages the desktop app with `electron-builder --dir`, then asserts the
# things dev mode can't tell you:
#   1. the app bundle contains @kestravault/core and the Claude Agent SDK
#      (the pnpm-symlink hoisting worry from electron-builder.yml),
#   2. the native Claude engine binary was extracted OUTSIDE app.asar with its
#      executable bit (child_process.spawn can't run files inside the archive),
#   3. the packaged binary actually boots: KESTRAVAULT_SMOKE=1 starts the app
#      against a temp HOME, waits for the renderer to load, and exits 0/1
#      (see the smoke-mode block in apps/desktop/src/main/index.ts).
#
# Runs on macOS and Linux. Usage: scripts/smoke-packaged.sh
set -euo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "✗ $1" >&2
  exit 1
}

echo "── building packages"
pnpm build

echo "── packaging (electron-builder --dir)"
pnpm --filter @kestravault/desktop exec electron-builder --dir

DIST=apps/desktop/dist
LAUNCH_FLAGS=""
case "$(uname -s)" in
  Darwin)
    APP=$(ls -d "$DIST"/mac*/KestraVault.app 2>/dev/null | head -1)
    [ -n "$APP" ] || fail "no packaged .app under $DIST"
    RES="$APP/Contents/Resources"
    EXE="$APP/Contents/MacOS/KestraVault"
    ;;
  Linux)
    RES="$DIST/linux-unpacked/resources"
    EXE=$(find "$DIST/linux-unpacked" -maxdepth 1 -type f -perm -100 \
      \( -name "KestraVault" -o -name "kestravault" \) 2>/dev/null | head -1)
    [ -n "$EXE" ] || fail "no packaged executable under $DIST/linux-unpacked"
    # The unpacked dir has no setuid chrome-sandbox helper.
    LAUNCH_FLAGS="--no-sandbox"
    ;;
  *)
    echo "unsupported host OS for this smoke test (macOS/Linux only)" >&2
    exit 2
    ;;
esac

ASAR="$RES/app.asar"
echo "── checking bundle contents ($ASAR)"
[ -f "$ASAR" ] || fail "app.asar missing"
[ -x "$EXE" ] || fail "app executable missing: $EXE"
# The asar header is a JSON directory listing, so grepping the raw archive for
# package names is a dependency-free presence check.
grep -qa '"@kestravault"' "$ASAR" || fail "@kestravault/core missing from the bundle (pnpm hoisting?)"
grep -qa 'claude-agent-sdk' "$ASAR" || fail "@anthropic-ai/claude-agent-sdk missing from the bundle"
find "$RES/app.asar.unpacked" -type f -perm -100 \( -name claude -o -name claude.exe \) 2>/dev/null |
  grep -q . || fail "Claude engine binary not extracted to app.asar.unpacked (AI would be broken)"
echo "✓ bundle contains @kestravault/core, the agent SDK, and the extracted engine binary"

echo "── booting the packaged app (smoke mode)"
OUT=$(KESTRAVAULT_SMOKE=1 "$EXE" $LAUNCH_FLAGS 2>&1 || true)
echo "$OUT" | grep "KESTRAVAULT_SMOKE:" || true
echo "$OUT" | grep -q "KESTRAVAULT_SMOKE:OK" || fail "packaged app failed to boot — output above"
echo "✓ packaged app boots"
