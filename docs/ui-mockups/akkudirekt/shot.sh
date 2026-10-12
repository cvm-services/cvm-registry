#!/bin/bash
# Render every akkudirekt mockup screen to PNG at 2x. Guards: (1) PNG sizes
# must differ across screens, (2) dump-dom must contain our copy text.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/png"
mkdir -p "$OUT"
CHROME=""
for c in google-chrome google-chrome-stable chromium chromium-browser; do
  command -v "$c" >/dev/null 2>&1 && CHROME="$c" && break
done
[ -z "$CHROME" ] && { echo "NO CHROME FOUND"; exit 1; }

shot() { # $1 html  $2 screen  $3 w   $4 h   $5 name  $6 guard-text
  "$CHROME" --headless=old --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size="$3,$4" --force-device-scale-factor=2 \
    --screenshot="$OUT/$5.png" "file://$DIR/$1?s=$2" >/dev/null 2>&1
  if ! "$CHROME" --headless=old --disable-gpu --no-sandbox --dump-dom "file://$DIR/$1?s=$2" 2>/dev/null \
       | grep -q "$6"; then
    echo "DOM-GUARD-FAIL $1 s=$2 (no '$6' in DOM)"
  fi
}

# customer phone 390x844
shot customer.html 1 390 844 customer-1-fitfinder   "matching batteries"
shot customer.html 2 390 844 customer-2-results      "Fits your Golf VII"
shot customer.html 3 390 844 customer-3-product      "intAct Start-Stop-Power EFB"
shot customer.html 4 390 844 customer-4-basket       "Batteriepfand"
shot customer.html 5 390 844 customer-5-pay         "Invoice expires"
shot customer.html 6 390 844 customer-6-status      "facilitator buying"
# facilitator desktop 1440x900
shot facilitator.html 1 1440 900 facilitator-1-queue      "Order queue"
shot facilitator.html 2 1440 900 facilitator-2-order       "akkudirekt.de checkout"
shot facilitator.html 3 1440 900 facilitator-3-settlements  "Pfand held"

# blank-render guard: sizes must differ
sizes=$(ls -l "$OUT"/*.png | awk '{print $5}' | sort | uniq | wc -l)
files=$(ls "$OUT"/*.png | wc -l)
echo "rendered $files PNGs, $sizes distinct sizes"
[ "$files" -gt 2 ] && [ "$sizes" -gt 2 ] || { echo "SUSPECT BLANK RENDER"; exit 1; }