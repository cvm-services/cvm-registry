#!/bin/bash
# Render every mockup screen to PNG with headless Chrome.
#   bash docs/ui-mockups/shot.sh
# Output: docs/ui-mockups/screens/<file>.png
#   mobile  screen-N-<slug>.png          780x1688  (2x of a 390x844 phone)
#   desktop desktop-N-<slug>.png        2880x1800  (2x of a 1440x900 window)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/screens"
CHROME="${CHROME:-/usr/bin/google-chrome-stable}"
mkdir -p "$OUT"

shoot() { # <file> <url> <w> <h>
  "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --window-size="$3,$4" --force-device-scale-factor=2 \
    --screenshot="$OUT/$1" "$2" >/dev/null 2>&1
  printf '%-30s %s\n' "$1" "$(identify -format '%wx%h %b' "$OUT/$1" 2>/dev/null || stat -c '%s bytes' "$OUT/$1")"
}

# Mobile: the ordering flow, in reading order.
for entry in 1:services 2:menu 3:basket 4:handoff-basket 5:venue-site 6:details; do
  n="${entry%%:*}"; slug="${entry##*:}"
  shoot "screen-$n-$slug.png" "file://$HERE/mockups.html?s=$n" 390 844
done

# Desktop: the same flow laid out as a three-pane app.
for entry in 1:services-menu-cart 2:handoff-basket 3:venue-site-details; do
  n="${entry%%:*}"; slug="${entry##*:}"
  shoot "desktop-$n-$slug.png" "file://$HERE/mockups-desktop.html?s=$n" 1440 900
done
