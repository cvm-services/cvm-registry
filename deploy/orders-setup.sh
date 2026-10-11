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
#      FACILITATOR_NPUB (required, public key), BIND_ADDR, CASHU_MINT_URL.
#
# `config/` is part of the release, not an afterthought: `main.ts` prices every
# basket from its own copy of the venue catalog (`config/venues.json`, ADR-0008
# — the client never sets a price) and resolves the rail from `config/mint.json`
# when CASHU_MINT_URL is unset. Shipping only `src` starts a service that answers
# `503 catalog_unavailable` on every POST /orders: a green deploy and a dead Pay
# button. Both files are therefore in the tar below, and their absence on the
# host is checked after the ship.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-debian@testserver2.fips}"
DEST="${DEST:-/opt/tollgate/cvm-orders}"
PORT="${PORT:-8788}"
BIND_ADDR="${BIND_ADDR:-127.0.0.1}"
CASHU_MINT_URL="${CASHU_MINT_URL:-}"
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
# Refuse to ship a tree that cannot price (ADR-0008: the catalog is the price
# source) or cannot resolve a rail. A missing config/ is the difference between
# "deployed" and "the Pay button 503s", and it is invisible from the outside.
for f in main.ts deno.json src/store.ts config/venues.json config/mint.json; do
  [ -f "$ORDERS_REPO/$f" ] || { echo "ERROR: $ORDERS_REPO/$f missing — refusing to ship a service that cannot price" >&2; exit 2; }
done
echo "== ship to $HOST:$DEST"
tar -C "$ORDERS_REPO" -cf - main.ts deno.json deno.lock config src \
  | ssh "${SSH_OPTS[@]}" "$HOST" \
    "sudo mkdir -p $DEST && sudo tar -C $DEST -xf - && sudo chown -R root:root $DEST"
ssh "${SSH_OPTS[@]}" "$HOST" "test -s $DEST/config/venues.json" \
  || { echo "ERROR: $DEST/config/venues.json did not land" >&2; exit 1; }

echo "== install unit + env file + start"
scp -q "${SSH_OPTS[@]}" "$REPO/deploy/cvm-orders-remote-setup.sh" "$HOST":/tmp/cvm-orders-remote-setup.sh
ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo DEST='$DEST' PORT='$PORT' BIND_ADDR='$BIND_ADDR' FACILITATOR_NPUB='$FACILITATOR_NPUB' \
     CASHU_MINT_URL='$CASHU_MINT_URL' \
     bash /tmp/cvm-orders-remote-setup.sh"
echo "== done. probe through the origin: curl -s https://cvm-pwa.orangesync.tech/api/health"
