#!/usr/bin/env bash
# deploy/deploy-pwa.sh - publish the customer order PWA to cvm-pwa.orangesync.tech
#
#   HOST=debian@testserver2.fips bash deploy/deploy-pwa.sh
#
# Serves the same files the emulator test consumes, at the paths app.js expects:
#   /order/                     -> site/order/*
#   /menu.json                  -> site/menu.json      (app fetches ../menu.json)
#   /vocab/service-inputs.json  -> vocab/service-inputs.json (declared inputs)
# Shipping without those siblings leaves the app "working" but unable to price
# or to render its declared inputs - the same silent-empty failure the dashboard
# deploy warns about.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-debian@testserver2.fips}"
DEST="${DEST:-/opt/tollgate/cvm-pwa}"
DOMAIN="${DOMAIN:-cvm-pwa.orangesync.tech}"
SSH_OPTS=(-o BatchMode=yes)

[ -f "$REPO/site/order/index.html" ] || { echo "ERROR: site/order/ missing" >&2; exit 1; }

BUNDLE="$(mktemp -d /tmp/cvm-pwa-bundle-XXXX)"
mkdir -p "$BUNDLE/order" "$BUNDLE/vocab"
cp "$REPO"/site/order/* "$BUNDLE/order/"
cp "$REPO/site/menu.json" "$BUNDLE/menu.json"
cp "$REPO/vocab/service-inputs.json" "$BUNDLE/vocab/service-inputs.json"
[ -d "$REPO/site/fixtures" ] && cp -r "$REPO/site/fixtures" "$BUNDLE/fixtures"
echo "== bundle:"; (cd "$BUNDLE" && find . -type f | sed 's/^/   /')

echo "== ship to $HOST:$DEST"
tar -C "$BUNDLE" -cf - . | ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo mkdir -p $DEST && sudo tar -C $DEST -xf - && sudo chown -R root:root $DEST"

echo "== caddy site block for $DOMAIN"
ssh "${SSH_OPTS[@]}" "$HOST" "sudo bash -s" <<REMOTE
set -euo pipefail
if ! grep -q "$DOMAIN" /etc/caddy/Caddyfile; then
  cat >> /etc/caddy/Caddyfile <<'EOF'

$DOMAIN {
	encode gzip
	root * $DEST
	file_server
	try_files {path} /order/index.html
	header Cache-Control "no-store"
}
EOF
  echo "   appended site block"
else
  echo "   site block already present"
fi
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "   caddy config: valid"
else
  echo "   caddy config: INVALID - not reloading" >&2; exit 1
fi
systemctl reload caddy
echo "   caddy: \$(systemctl is-active caddy)"
REMOTE

echo "== verify"
for p in /order/ /menu.json /vocab/service-inputs.json; do
  printf '   %-28s ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' -m 15 "https://$DOMAIN$p" || true
done
echo "done. open https://$DOMAIN/order/"
