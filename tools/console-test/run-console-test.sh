#!/usr/bin/env bash
# T4 evidence runner — the one command that produces the happy-path recording.
#
#   tools/console-test/run-console-test.sh
#
# It pins the provenance (console commit, harness commit, branch), runs the single
# Playwright take, then PROVES the video that landed is a real 1280x720 recording of
# something (ffprobe: geometry + duration), because a green test with a 0-byte .webm
# is not evidence. Exit code is the harness's.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO"

export CONSOLE_SHA="${CONSOLE_SHA:-$(git log -1 --format=%h -- site/console/)}"
export HARNESS_SHA="${HARNESS_SHA:-$(git log -1 --format=%h -- tools/console-test 2>/dev/null || echo uncommitted)}"
export BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
export CVM_ORDERS_DIR="${CVM_ORDERS_DIR:-$HOME/repos/cvm-orders}"

printf 'repo under test : %s\n' "$REPO"
printf 'branch          : %s\n' "$BRANCH"
printf 'console commit  : %s\n' "$CONSOLE_SHA"
printf 'harness commit  : %s\n' "$HARNESS_SHA"
printf 'order service   : %s\n' "$CVM_ORDERS_DIR"

[ -f "$CVM_ORDERS_DIR/main.ts" ] || { echo "FATAL: no cvm-orders checkout at $CVM_ORDERS_DIR (set CVM_ORDERS_DIR)" >&2; exit 2; }

set +e
node tools/console-test/console_happy_path.mjs
rc=$?
set -e

WEBM="$REPO/evidence/t_4726349b/console-happy-path.webm"
MP4="$REPO/evidence/t_4726349b/console-happy-path.mp4"
FACTS="$REPO/evidence/t_4726349b/console-happy-path.facts.json"
[ "$rc" -eq 0 ] || { echo "harness FAILED (exit $rc) — see $FACTS"; exit "$rc"; }

command -v ffprobe >/dev/null || { echo "FATAL: ffprobe missing, cannot verify the video" >&2; exit 3; }
# Also publish an .mp4 alongside the .webm: the other evidence bundles in this repo
# ship .mp4, and every player handles it.
if command -v ffmpeg >/dev/null; then
  ffmpeg -v error -y -i "$WEBM" -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$MP4"
else
  echo "WARN: ffmpeg missing — leaving only the .webm" >&2
fi
VERIFY="$([ -f "$MP4" ] && echo "$MP4" || echo "$WEBM")"

read -r w h dur < <(ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height -show_entries format=duration -of default=nw=1:nk=1 "$VERIFY" | paste -sd' ' -)
printf 'video           : %s\n' "$VERIFY"
printf 'video geometry  : %sx%s, %ss\n' "$w" "$h" "$dur"

[ "$w" = "1280" ] && [ "$h" = "720" ] || { echo "FATAL: video is ${w}x${h}, not 1280x720" >&2; exit 4; }
awk -v d="$dur" 'BEGIN{exit !(d > 5)}' || { echo "FATAL: video is only ${dur}s — too short to be the flow" >&2; exit 5; }

# Frame count + brightness, as the card requires: a stub file, a black take or a frozen
# frame cannot pass as a recording. 596 frames on the reference take; the guard is set
# well below that only so a slow host is not punished, while still dwarfing a stub.
read -r frames luma < <(ffprobe -v error -count_frames -select_streams v:0 \
    -show_entries stream=nb_read_frames -of default=nw=1:nk=1 "$VERIFY" | head -1 | paste -sd' ' -)
luma=$(ffmpeg -v error -i "$VERIFY" -vf "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-" \
    -f null - 2>/dev/null | sed -n 's/.*YAVG=\([0-9.]*\).*/\1/p' \
  | awk '{s+=$1; n++} END{ if (n) printf "%.1f", s/n; else print 0 }')
printf 'frames / mean luma: %s / %s (0=black, 255=white)\n' "$frames" "$luma"

[ "${frames:-0}" -gt 100 ] || { echo "FATAL: only ${frames} frames — that is not a recording" >&2; exit 6; }
awk -v l="$luma" 'BEGIN{exit !(l > 8 && l < 250)}' \
  || { echo "FATAL: mean luma ${luma} — the video is blank/black, not a rendered flow" >&2; exit 7; }

echo
echo "T4 EVIDENCE OK — one test, one 1280x720 recording, against the real cvm-orders slice."
