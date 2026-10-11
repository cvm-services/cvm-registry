#!/bin/bash
# cvm-orders-remote-setup.sh — runs ON the PWA host as root.
#
# Installs the order service the /api/* proxy in the cvm-pwa vhost points at:
#   * /opt/tollgate/cvm-orders        (code, shipped by deploy/orders-setup.sh)
#   * /etc/systemd/system/cvm-orders.service
#   * /etc/cvm-orders/config.env      (FACILITATOR_NPUB, CASHU_MINT_URL, PORT, ORDER_DB_PATH)
#   * /var/lib/cvm-orders/orders.sqlite (the DURABLE order store, created on start)
#
# Required env: FACILITATOR_NPUB (public key — the console compares the signer's
# pubkey against it). Re-running WITHOUT it keeps the installed one. ADR-0013: no
# card data, no PSP secret and no private key ever belongs in this file.
#
# PORT, BIND_ADDR, ORDER_DB_DIR and SERVICE_USER are optional. BIND_ADDR stays
# loopback: the store has no authentication of its own (server-side NIP-98 is
# still open).
set -euo pipefail
DEST="${DEST:-/opt/tollgate/cvm-orders}"
PORT="${PORT:-8788}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
SERVICE_USER="${SERVICE_USER:-root}"
# The store lives OUTSIDE $DEST on purpose: deploy/orders-setup.sh re-tars the
# code directory on every deploy, so orders kept inside it would be wiped by a
# routine redeploy — the exact failure the file store exists to prevent.
ORDER_DB_DIR="${ORDER_DB_DIR:-/var/lib/cvm-orders}"
ORDER_DB_PATH="$ORDER_DB_DIR/orders.sqlite"
ENV_DIR=/etc/cvm-orders
DENO="${DENO:-/usr/local/bin/deno}"

[ -f "$DEST/main.ts" ] || { echo "ERROR: $DEST/main.ts missing — ship the code first" >&2; exit 1; }
[ -x "$DENO" ] || { echo "ERROR: $DENO missing — install deno on the host first" >&2; exit 1; }
[ "$SERVICE_USER" = root ] || { echo "ERROR: only SERVICE_USER=root is supported ($DENO lives under /root)" >&2; exit 1; }

mkdir -p "$ENV_DIR"
chmod 0755 "$ENV_DIR"

# config.env is the source of truth for values we must not silently blank. A
# re-run without FACILITATOR_NPUB keeps the installed one, and settings this
# script does not manage (CASHU_MINT_URL — which mint the rail points at) are
# carried over VERBATIM: rewriting the file from a template would quietly drop
# them and change where the money rail points.
PASSED_NPUB="${FACILITATOR_NPUB:-}"
EXISTING_NPUB="$(grep -m1 '^FACILITATOR_NPUB=npub1' "$ENV_DIR/config.env" 2>/dev/null | cut -d= -f2- || true)"
FACILITATOR_NPUB="${PASSED_NPUB:-$EXISTING_NPUB}"
if [ -z "$FACILITATOR_NPUB" ]; then
  echo "ERROR: FACILITATOR_NPUB is required and $ENV_DIR/config.env has none." >&2
  echo "       Re-run with: FACILITATOR_NPUB=<npub1...> bash deploy/orders-setup.sh" >&2
  exit 1
fi

# Everything that is not a comment and not one of the three keys this script
# owns. `grep -v` on an absent file is tolerated, so a first install works too.
PRESERVED="$(grep -vE '^[[:space:]]*#' "$ENV_DIR/config.env" 2>/dev/null | grep -vE '^(FACILITATOR_NPUB|PORT|ORDER_DB_PATH)=' | grep -vE '^[[:space:]]*$' || true)"

mkdir -p "$ORDER_DB_DIR"
chmod 0700 "$ORDER_DB_DIR"

cat > "$ENV_DIR/config.env" <<EOF
# Facilitator identity for the console NIP-98 challenge (cvm-orders).
# Public key only. Private material never belongs here (ADR-0013).
FACILITATOR_NPUB=$FACILITATOR_NPUB
PORT=$PORT
# Durable order store (SQLite, WAL). It holds the invoice a customer is paying
# and the sats-settlement claim; losing it strands paid sats, so it must not sit
# in the code directory a redeploy replaces.
ORDER_DB_PATH=$ORDER_DB_PATH
EOF
if [ -n "$PRESERVED" ]; then
  {
    echo ""
    echo "# Preserved from the previous install (settings this script does not manage)."
    echo "$PRESERVED"
  } >> "$ENV_DIR/config.env"
fi

# CASHU_MINT_URL is a deploy-time override of the committed config/mint.json
# selection (src/mints.ts: env wins, config is the fallback). It is a PUBLIC mint
# URL, so it belongs in this file; it is also the only thing that makes
# GET /orders/:id/invoice answer with a real BOLT11 — with neither a rail is
# configured, that endpoint is a 503 by design and no order can ever be paid.
# Written only when passed, so a re-run without it keeps the installed value and
# does not silently drop the rail the running service is already using.
if [ -n "${CASHU_MINT_URL:-}" ]; then
  CASHU_MINT_URL="${CASHU_MINT_URL%/}"
  if grep -q '^CASHU_MINT_URL=' "$ENV_DIR/config.env" 2>/dev/null; then
    sed -i "s|^CASHU_MINT_URL=.*|CASHU_MINT_URL=$CASHU_MINT_URL|" "$ENV_DIR/config.env"
  else
    printf 'CASHU_MINT_URL=%s\n' "$CASHU_MINT_URL" >> "$ENV_DIR/config.env"
  fi
  echo "   rail: CASHU_MINT_URL=$CASHU_MINT_URL"
elif grep -q '^CASHU_MINT_URL=' "$ENV_DIR/config.env" 2>/dev/null; then
  echo "   rail: kept installed $(grep '^CASHU_MINT_URL=' "$ENV_DIR/config.env")"
else
  echo "   rail: none in config.env — falling back to $DEST/config/mint.json (resolveMintUrl)"
fi
if [ -n "$PASSED_NPUB" ]; then
  echo "   wrote $ENV_DIR/config.env"
else
  echo "   kept existing FACILITATOR_NPUB; rewrote $ENV_DIR/config.env with PORT + ORDER_DB_PATH"
fi
chmod 0644 "$ENV_DIR/config.env"

cat > /etc/systemd/system/cvm-orders.service <<EOF
[Unit]
Description=cvm-orders — facilitated order lifecycle (the /api backend of the PWAs)
Documentation=https://github.com/cvm-services/cvm-orders
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$DEST
# config.env holds FACILITATOR_NPUB (public), CASHU_MINT_URL (public), PORT and
# ORDER_DB_PATH. The order store is a SQLite file (WAL) OUTSIDE the code
# directory: orders, the invoice a customer is paying and the exactly-once
# sats-settlement claim all survive a restart.
EnvironmentFile=$ENV_DIR/config.env
Environment=BIND_ADDR=$BIND_ADDR
# --allow-read is REQUIRED, not decorative: the service prices every basket from
# $DEST/config/venues.json and falls back to $DEST/config/mint.json for the rail,
# both through Deno.readTextFile. Without it the catalog load throws, is caught,
# and POST /orders answers 503 catalog_unavailable — a "deployed" service whose
# Pay button cannot create a single order.
# --allow-write, together with ORDER_DB_PATH, is what the durable store needs;
# without ORDER_DB_PATH main.ts would fall back to data/orders.sqlite inside
# WorkingDirectory, which a redeploy replaces.
ExecStart=$DENO run --allow-net --allow-env --allow-read --allow-write $DEST/main.ts
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Warm the module cache before the unit starts: main.ts imports deno std over
# https, and a service that cannot write DENO_DIR would restart-loop instead of
# failing loudly here.
(cd "$DEST" && "$DENO" cache main.ts >/dev/null)

systemctl daemon-reload
# `enable --now` is a NO-OP on a unit that is already running: the first run of
# this script left the OLD code in memory and the deploy looked successful
# (`Active: active ... 14h ago`, same PID, while $DEST/main.ts was new). A
# redeploy only takes effect on an explicit restart.
systemctl enable cvm-orders.service >/dev/null
systemctl restart cvm-orders.service
sleep 1
systemctl --no-pager --lines=0 status cvm-orders.service | head -4
echo "   listening:"
ss -ltnp 2>/dev/null | grep -E ":$PORT\b" || echo "   (nothing on :$PORT yet)"
if curl -fsS -m 5 "http://$BIND_ADDR:$PORT/health" >/dev/null; then
  echo "   health http://$BIND_ADDR:$PORT/health OK"
else
  echo "   health probe FAILED — see: journalctl -u cvm-orders -n 40" >&2
  exit 1
fi

# The store is the reason this unit exists in this shape: assert the durable file
# is really there and is a file (not the in-memory fallback), so a deploy that
# silently lost ORDER_DB_PATH fails here instead of at the first paid order.
if [ -f "$ORDER_DB_PATH" ]; then
  echo "   order store: $ORDER_DB_PATH ($(stat -c%s "$ORDER_DB_PATH") bytes, durable)"
else
  echo "   ERROR: $ORDER_DB_PATH was not created — the service is not durable." >&2
  echo "          Check ORDER_DB_PATH in $ENV_DIR/config.env and that ExecStart has --allow-read --allow-write." >&2
  exit 1
fi
