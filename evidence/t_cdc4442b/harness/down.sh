#!/usr/bin/env bash
# Upstream-DOWN pass: no listener on 127.0.0.1:8788. Proves the JSON handle_errors path (and,
# on the OLD vhost, that bare /api STILL answered the order document even with the service
# down — i.e. the defect was not "the service is down", it was the fallback).
set -uo pipefail
WT=/home/c03rad0r/worktrees/t_cdc4442b
SC=/home/c03rad0r/scratch/t_cdc4442b
CADDY=/home/c03rad0r/scratch/caddy2/root/usr/bin/caddy
PORT=18080
BASE="http://127.0.0.1:$PORT"
OUT=$WT/evidence/t_cdc4442b
export XDG_DATA_HOME=$SC/xdg/data XDG_CONFIG_HOME=$SC/xdg/config

ss -ltn | grep -q ':8788' && { echo "a listener is STILL on 8788 — refusing"; exit 1; }
echo "== no listener on 8788 (cvm-orders down), caddy $("$CADDY" version)"

start() { "$CADDY" run --config "$1" --adapter caddyfile > "$SC/caddy-down-$2.log" 2>&1 & CADDY_PID=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null -m 1 "$BASE/menu.json" && return 0; sleep 0.2; done
  echo "caddy did not start"; cat "$SC/caddy-down-$2.log"; return 1; }
stop() { [ -n "${CADDY_PID:-}" ] && kill "$CADDY_PID" 2>/dev/null; wait "$CADDY_PID" 2>/dev/null; CADDY_PID=""; }
probe() { local p="$1"; local hdr code size ct loc
  hdr=$(curl -s -D - -o "$SC/body.bin" -m 10 "$BASE$p")
  code=$(printf '%s' "$hdr" | head -1 | awk '{print $2}')
  size=$(wc -c < "$SC/body.bin" | tr -d ' ')
  ct=$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="content-type:"{print $2}' | head -1)
  loc=$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
  local doc=no; grep -q 'Loading venues' "$SC/body.bin" 2>/dev/null && doc=ORDER-DOC
  printf '  %-14s %-4s %-7s %-26s %-10s %s\n' "$p" "$code" "${size}b" "${ct:-–}" "${loc:-–}" "$doc"; }

for which in old new; do
  start "$SC/$which.caddyfile" "$which" || exit 1
  {
    echo "### $which vhost, cvm-orders DOWN (nothing on 127.0.0.1:8788)"
    printf '  %-14s %-4s %-7s %-26s %-10s %s\n' PATH CODE SIZE CONTENT-TYPE LOCATION BODY-IS-ORDER-DOC
    for p in /api /api/ /api/orders /style.css /nope /order/; do probe "$p"; done
    echo "  -- followed through (curl -L) for bare /api:"
    printf '     '
    curl -s -o "$SC/ft.bin" -w 'final=%{http_code} ct=%{content_type} redirects=%{num_redirects} ' -L -m 10 "$BASE/api"
    echo "body=$(head -c 100 "$SC/ft.bin")"
    echo "  -- body of /api/ (the handle_errors JSON):"
    curl -s -m 10 "$BASE/api/" | sed 's/^/     | /'
    echo
  } 2>&1 | tee "$OUT/local-matrix-DOWN-$which.txt"
  stop
done
echo "== done; $OUT/local-matrix-DOWN-{old,new}.txt"
