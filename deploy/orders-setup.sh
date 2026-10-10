#!/usr/bin/env bash
# deploy/orders-setup.sh — put cvm-orders behind the PWA host's /api proxy.
#
#   FACILITATOR_NPUB=npub1... bash deploy/orders-setup.sh
#
# Ships the cvm-orders code to the host, then runs
# deploy/cvm-orders-remote-setup.sh there (systemd unit + /etc/cvm-orders/config.env).
# Run it BEFORE deploy-pwa.sh: the vhost the PWA deploy installs proxies /api/* to
# the service this script starts.
#
# Env: HOST (ssh target), ORDERS_REPO (cvm-orders checkout), DEST, PORT,
#      FACILITATOR_NPUB (required, public key), BIND_ADDR.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-debian@testserver2.fips}"
DEST="${DEST:-/opt/tollgate/cvm-orders}"
PORT="${PORT:-8788}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
ORDERS_REPO="${ORDERS_REPO:-$(cd "$REPO/.." && pwd)/cvm-orders}"
SSH_OPTS=(-o BatchMode=yes)

if [ -z "${FACILITATOR_NPUB:-}" ]; then
  echo "ERROR: FACILITATOR_NPUB is required (the npub the console signs in as)." >&2
  echo "       It is a public key — ADR-0013 only forbids private/card material." >&2
  exit 2
fi
[ -f "$ORDERS_REPO/main.ts" ] || {
  echo "ERROR: no cvm-orders checkout at $ORDERS_REPO (set ORDERS_REPO=…)" >&2; exit 2; }

echo "== code from $ORDERS_REPO"
git -C "$ORDERS_REPO" log --oneline -1 | sed 's/^/   /'
echo "== ship to $HOST:$DEST"
tar -C "$ORDERS_REPO" -cf - main.ts deno.json deno.lock src \
  | ssh "${SSH_OPTS[@]}" "$HOST" \
    "sudo mkdir -p $DEST && sudo tar -C $DEST -xf - && sudo chown -R root:root $DEST"

echo "== install unit + env file + start"
scp -q "${SSH_OPTS[@]}" "$REPO/deploy/cvm-orders-remote-setup.sh" "$HOST":/tmp/cvm-orders-remote-setup.sh
ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo DEST='$DEST' PORT='$PORT' BIND_ADDR='$BIND_ADDR' FACILITATOR_NPUB='$FACILITATOR_NPUB' \
     bash /tmp/cvm-orders-remote-setup.sh"
echo "== done. probe through the origin: curl -s https://cvm-pwa.orangesync.tech/api/health"
