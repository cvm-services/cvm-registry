#!/usr/bin/env bash
# run-pwa-emulator-test.sh - reproduce the customer-PWA Android emulator test.
#
# Verified 2026-10-09 on the wa-dev AVD (android-34 google_apis_playstore,
# 360x800) on dq05: serves the repo, drives Chrome on a headless guest through
# uiautomator2, captures one screenshot per screen.
#
# Usage:
#   tools/pwa-emulator-test/run-pwa-emulator-test.sh \
#       --emu-host c03rad0r@c03rad0r-dq05proplus.local --url-host 192.168.2.43
#
# Requirements: emulator host with openable /dev/kvm + Android SDK + the AVD;
# python3 (uiautomator2 is installed automatically); guest able to reach
# --url-host. Chrome's first-run dialogs are cleared by the driver, not by taps.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
EMU_HOST="${EMU_HOST:-}"
EXTERNAL_URL="${EXTERNAL_URL:-}"
AVD="${AVD:-wa-dev}"
PORT="${PORT:-8099}"
URL_HOST="${URL_HOST:-}"
KEEP=0
OUT="${OUT:-$REPO_ROOT/artifacts/pwa-emulator}"

while [ $# -gt 0 ]; do
  case "$1" in
    --emu-host) EMU_HOST="$2"; shift ;;
    --avd) AVD="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --url-host) URL_HOST="$2"; shift ;;
    --out) OUT="$2"; shift ;;
    --external-url) EXTERNAL_URL="$2"; shift ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$EMU_HOST" ] || { echo "ERROR: --emu-host is required" >&2; exit 2; }
[ -n "$URL_HOST" ] || URL_HOST="$(hostname -I | awk '{print $1}')"

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$EXTERNAL_URL" ]; then
  echo "== 1/6 external URL mode: driving $EXTERNAL_URL (no local serve)"
else
echo "== 1/6 serve the PWA ($REPO_ROOT) on 0.0.0.0:$PORT"
( cd "$REPO_ROOT" && python3 -m http.server "$PORT" --bind 0.0.0.0 >/tmp/pwa-emulator-http.log 2>&1 & echo $! >/tmp/pwa-emulator-http.pid )
sleep 2
cleanup() { [ "$KEEP" = 1 ] || kill "$(cat /tmp/pwa-emulator-http.pid 2>/dev/null)" 2>/dev/null || true; }
trap cleanup EXIT
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/site/order/" && echo "   serving OK"
fi
TARGET_URL="${EXTERNAL_URL:-http://$URL_HOST:$PORT/site/order/}"

echo "== 2/6 ensure uiautomator2 on $EMU_HOST"
ssh "${SSH_OPTS[@]}" "$EMU_HOST" 'python3 -c "import uiautomator2" 2>/dev/null || pip3 install --user --break-system-packages -q uiautomator2'

echo "== 3-4/6 boot guest + wait for boot"
scp -q "${SSH_OPTS[@]}" "$HERE/emu_boot_and_wait.sh" "$HERE/drive_pwa.py" "$HERE/emu_teardown.sh" "$EMU_HOST:/tmp/"
ssh "${SSH_OPTS[@]}" "$EMU_HOST" "bash /tmp/emu_boot_and_wait.sh $AVD"
# Let the guest settle before handing it to Chrome: driving immediately after
# sys.boot_completed makes Chrome ANR on a cold emulator (observed 2026-10-09).
echo "   settling 30s before driving"
sleep 30

echo "== 5/6 drive the PWA"
mkdir -p "$OUT"
ssh "${SSH_OPTS[@]}" "$EMU_HOST" "rm -rf /tmp/pwa-shots && python3 /tmp/drive_pwa.py --url $TARGET_URL --out /tmp/pwa-shots"

echo "== 6/6 collect screenshots -> $OUT"
scp -q "${SSH_OPTS[@]}" "$EMU_HOST:/tmp/pwa-shots/*.png" "$OUT/" 2>/dev/null || echo "   WARN: no screenshots collected"
ls -1 "$OUT" | sed 's/^/   /'

if [ "$KEEP" != 1 ]; then
  echo "== teardown (guest is ~3.3 GB; never leave it holding the rail)"
  ssh "${SSH_OPTS[@]}" "$EMU_HOST" 'bash /tmp/emu_teardown.sh'
fi
echo "done."
