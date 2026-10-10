#!/bin/bash
# cvm-orders-remote-setup.sh — runs ON the PWA host as root.
#
# Installs the order service the /api/* proxy in the cvm-pwa vhost points at:
#   * /opt/tollgate/cvm-orders        (code, shipped by deploy/orders-setup.sh)
#   * /etc/systemd/system/cvm-orders.service
#   * /etc/cvm-orders/config.env      (FACILITATOR_NPUB, PORT)
#
# Required env: FACILITATOR_NPUB (public key — the console compares the signer's
# pubkey against it). ADR-0013: no card data, no PSP secret and no private key
# ever belongs in this file.
#
# PORT, BIND_ADDR and SERVICE_USER are optional. BIND_ADDR stays loopback: the
# store has no authentication of its own (server-side NIP-98 is still open).
set -euo pipefail
DEST="${DEST:-/opt/tollgate/cvm-orders}"
PORT="${PORT:-8788}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
SERVICE_USER="${SERVICE_USER:-root}"
ENV_DIR=/etc/cvm-orders
DENO="${DENO:-/usr/local/bin/deno}"

[ -f "$DEST/main.ts" ] || { echo "ERROR: $DEST/main.ts missing — ship the code first" >&2; exit 1; }
[ -x "$DENO" ] || { echo "ERROR: $DENO missing — install deno on the host first" >&2; exit 1; }
[ "$SERVICE_USER" = root ] || { echo "ERROR: only SERVICE_USER=root is supported ($DENO lives under /root)" >&2; exit 1; }

mkdir -p "$ENV_DIR"
chmod 0755 "$ENV_DIR"

# config.env is the source of truth for a value we must not silently blank: a
# re-run without FACILITATOR_NPUB keeps what is already installed.
if [ -n "${FACILITATOR_NPUB:-}" ]; then
  cat > "$ENV_DIR/config.env" <<EOF
# Facilitator identity for the console NIP-98 challenge (cvm-orders).
# Public key only. Private material never belongs here (ADR-0013).
FACILITATOR_NPUB=$FACILITATOR_NPUB
PORT=$PORT
EOF
  echo "   wrote $ENV_DIR/config.env"
elif grep -q '^FACILITATOR_NPUB=npub1' "$ENV_DIR/config.env" 2>/dev/null; then
  echo "   kept existing $ENV_DIR/config.env (no FACILITATOR_NPUB passed)"
else
  echo "ERROR: FACILITATOR_NPUB is required and $ENV_DIR/config.env has none." >&2
  echo "       Re-run with: FACILITATOR_NPUB=<npub1...> bash deploy/orders-setup.sh" >&2
  exit 1
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
# config.env holds FACILITATOR_NPUB (public) and PORT. The order store is
# IN MEMORY: a restart empties the queue by design, not by bug.
EnvironmentFile=$ENV_DIR/config.env
Environment=BIND_ADDR=$BIND_ADDR
ExecStart=$DENO run --allow-net --allow-env $DEST/main.ts
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
systemctl enable --now cvm-orders.service >/dev/null
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
