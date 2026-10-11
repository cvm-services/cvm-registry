#!/usr/bin/env bash
# Local behavioural matrix for the cvm-pwa vhost: OLD (shipped, unscoped catch-all) vs
# NEW (this branch). Real Caddy 2.6.2, real curl, real docroot layout from deploy-pwa.sh.
#
#   bash /home/c03rad0r/scratch/t_cdc4442b/matrix.sh
#
# Produces, per config: status / size / content-type / Location / is-it-the-order-document.
set -uo pipefail

WT=/home/c03rad0r/worktrees/t_cdc4442b
SC=/home/c03rad0r/scratch/t_cdc4442b
CADDY=/home/c03rad0r/scratch/caddy2/root/usr/bin/caddy
PORT=18080
BASE="http://127.0.0.1:$PORT"
DOC=$SC/docroot
OUT=$WT/evidence/t_cdc4442b
mkdir -p "$OUT"

export XDG_DATA_HOME=$SC/xdg/data
export XDG_CONFIG_HOME=$SC/xdg/config
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME"

# ---- docroot, exactly the file set deploy/deploy-pwa.sh ships ---------------------------
rm -rf "$DOC"; mkdir -p "$DOC/order" "$DOC/console" "$DOC/vocab"
cp "$WT"/site/order/* "$DOC/order/"
cp "$WT"/site/console/* "$DOC/console/"
cp "$WT/site/menu.json" "$DOC/menu.json"
cp "$WT/vocab/service-inputs.json" "$DOC/vocab/service-inputs.json"
[ -d "$WT/site/fixtures" ] && cp -r "$WT/site/fixtures" "$DOC/fixtures"

gen_config() { # $1 = source vhost, $2 = dest config
  {
    printf '{\n\tadmin off\n\tauto_https off\n}\n\n'
    sed -e "s|^cvm-pwa.orangesync.tech {|$BASE {|" \
        -e "s|root \* /opt/tollgate/cvm-pwa|root * $DOC|" "$1"
  } > "$2"
}

gen_config "$SC/vhost-old.caddy" "$SC/old.caddyfile"
gen_config "$WT/deploy/caddy-vhost-cvm-pwa.caddy" "$SC/new.caddyfile"

echo "== caddy version"; "$CADDY" version
echo "== configs: $SC/old.caddyfile (HEAD~1) and $SC/new.caddyfile (this branch)"

# ---- stand-in upstream for cvm-orders on 127.0.0.1:8788 ---------------------------------
python3 "$SC/fake-api.py" 8788 & API_PID=$!
sleep 0.5
curl -s -m 2 http://127.0.0.1:8788/health >/dev/null || { echo "fake api did not start"; exit 1; }
echo "== fake cvm-orders up on 127.0.0.1:8788 (pid $API_PID)"

start_caddy() { # $1 = config
  "$CADDY" run --config "$1" --adapter caddyfile > "$SC/caddy-$2.log" 2>&1 &
  CADDY_PID=$!
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null -m 1 "$BASE/menu.json"; then return 0; fi
    sleep 0.2
  done
  echo "CADDY DID NOT START for $1"; cat "$SC/caddy-$2.log"; return 1
}

stop_caddy() {
  [ -n "${CADDY_PID:-}" ] && kill "$CADDY_PID" 2>/dev/null
  wait "$CADDY_PID" 2>/dev/null
  CADDY_PID=""
}

probe() { # $1 = path, $2 = extra curl args
  local path="$1"; shift
  local hdr body ct
  hdr=$(curl -s -D - -o "$SC/body.bin" -m 10 "$@" "$BASE$path")
  local code size loc
  code=$(printf '%s' "$hdr" | head -1 | awk '{print $2}')
  size=$(wc -c < "$SC/body.bin" | tr -d ' ')
  ct=$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="content-type:"{print $2}' | head -1)
  loc=$(printf '%s' "$hdr" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | head -1)
  local isorder="no"
  grep -q 'Loading venues' "$SC/body.bin" 2>/dev/null && isorder="ORDER-DOC"
  printf '  %-32s %-4s %-7s %-28s %-12s %s\n' "$path" "$code" "${size}b" "${ct:-–}" "${loc:-–}" "$isorder"
}

MATRIX_PATHS=(
  /api
  /api/
  /api/orders
  /api/health
  /style.css
  /app.js
  /nope
  /
  /order/
  /order/index.html
  /order/style.css
  /order/nope-route
  /order/sw.js
  /order/manifest.webmanifest
  /menu.json
  /vocab/service-inputs.json
  /console/
  /console/nope-route
  /fixtures/doppelt.catalog.json
)

run_matrix() { # $1 = label, $2 = config, $3 = outfile
  start_caddy "$2" "$1" || return 1
  {
    echo "### $1  ($2)"
    echo "GET matrix (upstream cvm-orders UP unless noted):"
    printf '  %-32s %-4s %-7s %-28s %-12s %s\n' "PATH" "CODE" "SIZE" "CONTENT-TYPE" "LOCATION" "BODY-IS-ORDER-DOC"
    for p in "${MATRIX_PATHS[@]}"; do probe "$p"; done
    echo "  -- 308 must preserve the method: POST /api"
    probe "/api" -X POST -d '{}'
    echo "  -- body of bare /api (first 120 bytes):"
    curl -s -m 10 "$BASE/api" | head -c 120 | sed 's/^/     | /'
    echo
  } 2>&1 | tee "$3"
  stop_caddy
}

followthrough() { # $1 = label, $2 = config, $3 = outfile
  start_caddy "$2" "ft-$1" || return 1
  {
    echo "### follow-through (client FOLLOWS redirects) — $1"
    for p in /api /; do
      printf '  GET %-6s ' "$p"
      curl -s -o "$SC/ft.bin" -w 'final=%{http_code} ct=%{content_type} redirects=%{num_redirects} size=%{size_download}b ' -L -m 10 "$BASE$p"
      if grep -q 'Loading venues' "$SC/ft.bin" 2>/dev/null; then echo "body=ORDER-DOC"; else echo "body=$(head -c 80 "$SC/ft.bin")"; fi
    done
    printf '  POST /api  '
    curl -s -o "$SC/ft.bin" -w 'final=%{http_code} ct=%{content_type} redirects=%{num_redirects} ' -L -m 10 -X POST -d '{"probe":true}' "$BASE/api"
    echo "body=$(head -c 100 "$SC/ft.bin")"
  } 2>&1 | tee "$3"
  stop_caddy
}

echo; echo "################ OLD vhost (origin/main, the defect) ################"
run_matrix old "$SC/old.caddyfile" "$OUT/local-matrix-OLD.txt"
followthrough old "$SC/old.caddyfile" "$OUT/local-followthrough-OLD.txt"
echo; echo "################ NEW vhost (this branch) ################"
run_matrix new "$SC/new.caddyfile" "$OUT/local-matrix-NEW.txt"
followthrough new "$SC/new.caddyfile" "$OUT/local-followthrough-NEW.txt"

# ---- upstream DOWN is a separate pass: see evidence/t_cdc4442b/harness/down.sh -----------
echo "== done; matrices in $OUT (upstream-down pass: harness/down.sh)"
