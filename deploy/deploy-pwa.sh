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
[ -f "$REPO/site/console/index.html" ] || { echo "ERROR: site/console/ missing" >&2; exit 1; }

BUNDLE="$(mktemp -d /tmp/cvm-pwa-bundle-XXXX)"
mkdir -p "$BUNDLE/order" "$BUNDLE/console" "$BUNDLE/vocab"
cp "$REPO"/site/order/* "$BUNDLE/order/"
# The facilitator console (PLAN-0007 T4). Same origin as the customer PWA so both UIs
# talk to the same /api -> cvm-orders proxy; card data never leaves the facilitator's
# device (ADR-0013), so nothing here is a payment form.
cp "$REPO"/site/console/* "$BUNDLE/console/"
cp "$REPO/site/menu.json" "$BUNDLE/menu.json"
cp "$REPO/vocab/service-inputs.json" "$BUNDLE/vocab/service-inputs.json"
[ -d "$REPO/site/fixtures" ] && cp -r "$REPO/site/fixtures" "$BUNDLE/fixtures"
echo "== bundle:"; (cd "$BUNDLE" && find . -type f | sed 's/^/   /')

echo "== ship to $HOST:$DEST"
tar -C "$BUNDLE" -cf - . | ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo mkdir -p $DEST && sudo tar -C $DEST -xf - && sudo chown -R root:root $DEST"

# Caddy runs as user 'caddy' and must be able to traverse and read the tree.
# Without this every request 403s and the deploy LOOKS fine (files are present)
# - observed 2026-10-09 on the first cvm-pwa deploy.
ssh "${SSH_OPTS[@]}" "$HOST" \
  "sudo find $DEST -type d -exec chmod 755 {} + && sudo find $DEST -type f -exec chmod 644 {} +"

echo "== caddy vhost for $DOMAIN (source: deploy/caddy-vhost-cvm-pwa.caddy)"
# The vhost is a repo file, not a string appended here: it carries the /api ->
# cvm-orders proxy (127.0.0.1:8788) and the JSON error that replaces the SPA
# fallback when that service is down. rewrite-caddy-vhost.py REPLACES an older
# block for the domain, so a re-deploy cannot leave the legacy vhost in place.
grep -q "^$DOMAIN {" "$REPO/deploy/caddy-vhost-cvm-pwa.caddy" || {
  echo "ERROR: deploy/caddy-vhost-cvm-pwa.caddy has no block for $DOMAIN" >&2; exit 1; }
grep -q "^	root \* $DEST\$" "$REPO/deploy/caddy-vhost-cvm-pwa.caddy" || {
  echo "ERROR: the vhost file does not serve $DEST — update it or unset DEST (it is the source of truth)" >&2; exit 1; }
scp -q "${SSH_OPTS[@]}" "$REPO/deploy/caddy-vhost-cvm-pwa.caddy" "$HOST":/tmp/cvm-pwa.caddy
scp -q "${SSH_OPTS[@]}" "$REPO/deploy/rewrite-caddy-vhost.py" "$HOST":/tmp/rewrite-caddy-vhost.py
ssh "${SSH_OPTS[@]}" "$HOST" "sudo bash -s" <<REMOTE
set -euo pipefail
python3 /tmp/rewrite-caddy-vhost.py "$DOMAIN" /tmp/cvm-pwa.caddy /etc/caddy/Caddyfile
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
for p in /order/ /console/ /menu.json /vocab/service-inputs.json /api/health; do
  printf '   %-28s ' "$p"
  curl -s -o /dev/null -w '%{http_code} %{size_download}b %{content_type}\n' -m 15 "https://$DOMAIN$p" || true
done

# /console/ must serve the CONSOLE's document, not the customer SPA fallback
# (the pre-2026-10-10 vhost answered /console/ with /order/index.html).
curl -s -m 15 "https://$DOMAIN/console/" -o /tmp/console-live.html
if cmp -s /tmp/console-live.html "$REPO/site/console/index.html"; then
  echo "   /console/ document == site/console/index.html"
else
  echo "   ERROR: /console/ is not serving site/console/index.html" >&2; exit 1
fi
for asset in app.js style.css; do
  printf '   %-28s ' "/console/$asset"
  curl -s -o /dev/null -w '%{http_code} %{size_download}b\n' -m 15 "https://$DOMAIN/console/$asset" || true
done

# /api/* must answer JSON — with a live cvm-orders and (see the vhost's
# handle_errors) with a dead one. A text/html answer here means the SPA fallback
# is still swallowing /api, i.e. the defect this deploy closes.
printf '   %-28s ' "/api/auth/challenge"
API_CT=$(curl -s -o /tmp/api-challenge.json -w '%{http_code} %{content_type}' -m 15 "https://$DOMAIN/api/auth/challenge" || true)
echo "$API_CT"
case "$API_CT" in
  *application/json*) grep -q facilitatorNpub /tmp/api-challenge.json \
      && echo "   /api is proxying to cvm-orders (challenge carries facilitatorNpub)" \
      || echo "   WARN: /api answered JSON but with no facilitatorNpub" ;;
  *) echo "   WARN: /api is not answering JSON ($API_CT) — is cvm-orders running?" >&2 ;;
esac

echo "done. customer https://$DOMAIN/order/ · facilitator https://$DOMAIN/console/"
