#!/bin/bash
# Render every mockup screen to PNG at 2x. Guards against the silent blank
# render: (1) PNG sizes must differ across screens, (2) dump-dom must contain
# our own copy text. See ui-mockup-design skill re: window.top pitfall.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/png"
mkdir -p "$OUT"
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  command -v "$c" >/dev/null 2>&1 && CHROME="$c" && break
done
[ -z "$CHROME" ] && { echo "NO CHROME FOUND"; exit 1; }
echo "chrome: $CHROME"

shot() { # $1 html  $2 screen  $3 w   $4 h   $5 name
  "$CHROME" --headless=old --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size="$3,$4" --force-device-scale-factor=2 \
    --screenshot="$OUT/$5.png" "file://$DIR/$1?s=$2" >/dev/null 2>&1
  # DOM guard: our copy must be present
  if ! "$CHROME" --headless=old --disable-gpu --no-sandbox --dump-dom "file://$DIR/$1?s=$2" 2>/dev/null \
       | grep -q "sats"; then
    echo "DOM-GUARD-FAIL $1 s=$2 (no 'sats' in DOM)"
  fi
}

# customer phone 390x844
shot customer.html 1 390 844 customer-1-home
shot customer.html 2 390 844 customer-2-menu
shot customer.html 3 390 844 customer-3-item
shot customer.html 4 390 844 customer-4-basket
shot customer.html 5 390 844 customer-5-pay
shot customer.html 6 390 844 customer-6-status
# facilitator desktop 1440x900
shot facilitator.html 1 1440 900 facilitator-1-queue
shot facilitator.html 2 1440 900 facilitator-2-placing
shot facilitator.html 3 1440 900 facilitator-3-settlements

echo "--- sizes (must differ) ---"
ls -la "$OUT" | awk '{print $5, $9}'
