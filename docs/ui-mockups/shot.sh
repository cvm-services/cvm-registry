#!/bin/bash
# Render every mockup screen to PNG with headless Chrome.
#   bash docs/ui-mockups/shot.sh
# Output: docs/ui-mockups/screens/screen-N-<slug>.png  (780x1688, 2x of a 390x844 phone)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/screens"
CHROME="${CHROME:-/usr/bin/google-chrome-stable}"
mkdir -p "$OUT"

# URL query -> file name. Order is the reading order of the flow.
SCREENS=(
  "1:services"
  "2:menu"
  "3:basket"
  "4:pay-lightning"
  "5:paid"
  "6:details"
)

for entry in "${SCREENS[@]}"; do
  n="${entry%%:*}"; slug="${entry##*:}"
  "$CHROME" --headless=old --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size=390,844 --force-device-scale-factor=2 \
    --default-background-color=00000000 \
    --screenshot="$OUT/screen-$n-$slug.png" \
    "file://$HERE/mockups.html?s=$n" >/dev/null 2>&1
  printf '%-28s %s\n' "screen-$n-$slug.png" "$(identify -format '%wx%h %b' "$OUT/screen-$n-$slug.png" 2>/dev/null || stat -c '%s bytes' "$OUT/screen-$n-$slug.png")"
done
