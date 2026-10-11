#!/usr/bin/env bash
# Mechanism probe (NOT a full script run — the real script needs root, systemd and
# a host). It extracts the config.env-writing hunk VERBATIM out of the shipped
# deploy/cvm-orders-remote-setup.sh and drives it in a temp ENV_DIR to prove the
# union of both intents:
#   * main/#27  : CASHU_MINT_URL override + "keeps the installed value"
#   * branch    : FACILITATOR_NPUB carried over, unmanaged settings preserved,
#                 ORDER_DB_PATH added
set -uo pipefail
SHIP="${1:-deploy/cvm-orders-remote-setup.sh}"
WORK="$(mktemp -d)"
fail=0

# Extract the hunk: from the "# config.env is the source of truth" comment to the
# "chmod 0644" line inclusive, verbatim from the shipped file.
awk '/^# config.env is the source of truth/{f=1} f{print} /^chmod 0644 /{if(f)exit}' "$SHIP" > "$WORK/hunk.sh"
echo "--- extracted hunk: $(wc -l < "$WORK/hunk.sh") lines ---"

run_hunk() { # $1=ENV_DIR  $2...=env assignments
  local envdir="$1"; shift
  ( set -euo pipefail
    ENV_DIR="$envdir"
    PORT="${PORT:-8788}"
    ORDER_DB_DIR="$envdir/db"
    ORDER_DB_PATH="$ORDER_DB_DIR/orders.sqlite"
    env "$@" bash -c '
      ENV_DIR="'"$ENV_DIR"'"; PORT="'"$PORT"'"
      ORDER_DB_DIR="'"$ORDER_DB_DIR"'"; ORDER_DB_PATH="'"$ORDER_DB_PATH"'"
      . "'"$WORK"'/hunk.sh"
    ' )
}

echo
echo "=== scenario 1: fresh install, CASHU_MINT_URL passed ==="
E1="$WORK/e1"; mkdir -p "$E1"
FACILITATOR_NPUB=npub1FRESH CASHU_MINT_URL=https://mint.example/ run_hunk "$E1" || { echo "SCENARIO1 FAILED"; fail=1; }
echo "--- config.env:"; cat "$E1/config.env"; echo "--- db dir:"; ls -ld "$E1/db"

echo
echo "=== scenario 2: re-run WITHOUT npub, WITHOUT CASHU_MINT_URL (must keep both) ==="
run_hunk "$E1" || { echo "SCENARIO2 FAILED"; fail=1; }
cat "$E1/config.env"

echo
echo "=== scenario 3: re-run without npub, CASHU_MINT_URL CHANGED (override, no duplicate) ==="
CASHU_MINT_URL=https://mint2.example/ run_hunk "$E1" || { echo "SCENARIO3 FAILED"; fail=1; }
cat "$E1/config.env"

echo
echo "=== scenario 4: an unmanaged setting added by hand survives ==="
echo "SOME_FUTURE_SETTING=keep-me" >> "$E1/config.env"
run_hunk "$E1" || { echo "SCENARIO4 FAILED"; fail=1; }
cat "$E1/config.env"

echo
echo "=== assertions ==="
C="$E1/config.env"
g() { grep -c "$1" "$C"; }
chk() { # name expected pattern
  local got; got="$(g "$2")"
  if [ "$got" = "$1" ]; then echo "PASS  $3 ($2 x$got)"; else echo "FAIL  $3 (want $1 x '$2', got $got)"; fail=1; fi
}
chk 1 '^FACILITATOR_NPUB=npub1FRESH$' "FACILITATOR_NPUB kept across re-runs without it"
# NB the script strips a trailing slash from CASHU_MINT_URL, so the stored value
# is https://mint2.example (the probe passed https://mint2.example/).
chk 1 '^CASHU_MINT_URL=https://mint2.example$' "CASHU_MINT_URL is the NEW value, exactly once"
chk 0 '^CASHU_MINT_URL=https://mint.example/$' "the old mint URL is gone (replaced, not appended)"
chk 1 '^PORT=8788$' "PORT written"
chk 1 "^ORDER_DB_PATH=$E1/db/orders.sqlite$" "ORDER_DB_PATH written and points outside DEST"
chk 1 '^SOME_FUTURE_SETTING=keep-me$' "an unmanaged setting survives the rewrite"
chk 1 'Preserved from the previous install' "the preservation is announced once (no duplicate blocks)"

echo
echo "=== static union checks on the shipped file ==="
s() { if grep -q "$2" "$SHIP"; then echo "PASS  $1"; else echo "FAIL  $1 ('$2' absent)"; fail=1; fi }
s "ExecStart allows read (catalog/mint: #27)"        'ExecStart=.*--allow-read'
s "ExecStart allows write (durable store: branch)"   'ExecStart=.*--allow-write'
s "enable AND restart, never bare 'enable --now'"    '^systemctl restart cvm-orders.service'
if grep -q 'systemctl enable --now' "$SHIP"; then echo "FAIL  'enable --now' still present"; fail=1; else echo "PASS  no 'enable --now' left"; fi
s "durable store asserted after start"               'ORDER_DB_PATH was not created'
s "loopback bind (vhost test) "                      'BIND_ADDR:-127.0.0.1'

echo
if [ "$fail" = 0 ]; then echo "PROBE RESULT: ALL CHECKS PASS"; else echo "PROBE RESULT: FAILURES PRESENT"; fi
rm -rf "$WORK"
exit "$fail"
