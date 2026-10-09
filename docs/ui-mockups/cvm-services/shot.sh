#!/bin/bash
# Render every CVM-services mockup screen to PNG at 2x.
# Guards (ui-mockup-design skill): (1) PNG sizes must differ across screens,
# (2) --dump-dom must contain a DISTINCTIVE copy string for that screen.
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

shot() { # $1 file  $2 query  $3 w  $4 h  $5 name  $6 dom-guard-string
  "$CHROME" --headless=old --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size="$3,$4" --force-device-scale-factor=2 \
    --screenshot="$OUT/$5.png" "file://$DIR/$1?$2" >/dev/null 2>&1
  if ! "$CHROME" --headless=old --disable-gpu --no-sandbox --dump-dom "file://$DIR/$1?$2" 2>/dev/null \
       | grep -q "$6"; then
    echo "DOM-GUARD-FAIL $1?$2 (missing: $6)"
  fi
}

# customer phone 390x844
shot customer.html "s=1"        390 844 customer-1-services "Search services"
shot customer.html "s=2&id=sms" 390 844 customer-2-detail   "What this needs from you"
shot customer.html "s=2&id=wa"  390 844 customer-3-unavail  "Not available yet"
shot customer.html "s=3&id=sms" 390 844 customer-4-pay      "Waiting for payment"
shot customer.html "s=4&id=sms" 390 844 customer-5-receipt  "best-effort rail"
# facilitator desktop 1280x800
shot facilitator.html "s=1" 1280 800 facilitator-1-queue    "Do it where it actually happens"
shot facilitator.html "s=2" 1280 800 facilitator-2-money    "Refunds owed"
shot facilitator.html "s=3" 1280 800 facilitator-3-services "Capabilities you publish"

echo "--- sizes (must differ) ---"
ls -la "$OUT" | awk '{print $5, $9}'
