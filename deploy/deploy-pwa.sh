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

# The order client is an installable PWA: the document alone renders, but only
# with the manifest, the icons and the worker does it install. A missing one of
# these ships a page that *looks* fine and can never be installed, so the deploy
# refuses to run rather than publish a half-PWA.
ORDER_PWA_ASSETS=(
  manifest.webmanifest
  sw.js
  icon-192.png
  icon-512.png
  icon-maskable-192.png
  icon-maskable-512.png
  apple-touch-icon.png
)
for asset in "${ORDER_PWA_ASSETS[@]}"; do
  [ -f "$REPO/site/order/$asset" ] || {
    echo "ERROR: site/order/$asset missing — the order client would ship un-installable" >&2; exit 1; }
done

# Every module the order app imports, transitively (ADR-0017). These are NOT
# optional: a missing one is a page that loads and then dies on import. The
# vendor bundle lives in a SUBDIRECTORY, which a plain `cp dir/*` silently drops
# — exactly how it first deployed. tests/order_shell_coverage_test.ts asserts the
# same set against the service worker's shell list.
ORDER_APP_MODULES=(
  app.js
  identity.js
  signer.js
  order_records.js
  order_relay.js
  vendor/nostr.mjs
)
for m in "${ORDER_APP_MODULES[@]}"; do
  [ -f "$REPO/site/order/$m" ] || {
    echo "ERROR: site/order/$m missing — the order client would fail on import" >&2; exit 1; }
done

BUNDLE="$(mktemp -d /tmp/cvm-pwa-bundle-XXXX)"
mkdir -p "$BUNDLE/order" "$BUNDLE/console" "$BUNDLE/vocab"
# Files only at the top level: a bare glob also matches the vendor DIRECTORY,
# and `cp` then exits non-zero ("omitting directory"), which under `set -e`
# aborts the whole deploy after copying nothing — a silent no-op deploy.
find "$REPO/site/order" -maxdepth 1 -type f -exec cp {} "$BUNDLE/order/" \;
# -r for the vendored Nostr bundle (a subdirectory the glob above cannot copy).
cp -r "$REPO/site/order/vendor" "$BUNDLE/order/vendor"
# The glob above is what actually carries the PWA assets; assert it did, because
# a bundle that silently lost them deploys a green-looking site (same class of
# failure as the caddy-user 403 below).
for asset in "${ORDER_PWA_ASSETS[@]}"; do
  [ -f "$BUNDLE/order/$asset" ] || {
    echo "ERROR: site/order/$asset did not reach the bundle — check the cp glob" >&2; exit 1; }
done
for m in "${ORDER_APP_MODULES[@]}"; do
  [ -f "$BUNDLE/order/$m" ] || {
    echo "ERROR: site/order/$m did not reach the bundle — the app would fail on import" >&2; exit 1; }
done
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
# The service worker version must move whenever the modules it caches change.
# Compare the ACTUAL module bytes, not the version string alone: a re-run of an
# unchanged deploy is idempotent and must not fail, but shipping changed modules
# under an unchanged SW_VERSION means every existing client keeps the old shell
# and never loads them — a deploy that looks green and changes nothing.
local_modules_hash="$(cat $(printf "$REPO/site/order/%s\n" "${ORDER_APP_MODULES[@]}") | sha256sum | cut -c1-16)"
remote_modules_hash="$(ssh "${SSH_OPTS[@]}" "$HOST" "cat $(printf "$DEST/order/%s " "${ORDER_APP_MODULES[@]}") 2>/dev/null | sha256sum | cut -c1-16" || true)"
LOCAL_SW_V="$(grep -oE 'SW_VERSION = "[^"]+"' "$REPO/site/order/sw.js" | head -1)"
REMOTE_SW_V="$(ssh "${SSH_OPTS[@]}" "$HOST" "grep -oE 'SW_VERSION = \"[^\"]+\"' $DEST/order/sw.js 2>/dev/null | head -1" || true)"
if [ -n "$remote_modules_hash" ] && [ "$local_modules_hash" != "$remote_modules_hash" ] &&
   [ "$LOCAL_SW_V" = "$REMOTE_SW_V" ]; then
  echo "ERROR: the order modules changed but site/order/sw.js still declares $LOCAL_SW_V." >&2
  echo "       Bump SW_VERSION: clients would keep the old shell and never load them." >&2
  exit 1
fi
echo "   service worker: $LOCAL_SW_V (host: ${REMOTE_SW_V:-none}); modules ${local_modules_hash}"
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

# The old cvm-orders console is retired; /console/ must redirect to the new
# facilitator queue, never serve the old document or the customer SPA.
printf '   %-28s ' "/console/ redirect"
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' -m 15 "https://$DOMAIN/console/" || true

# Installability, checked against the live origin rather than assumed: the
# manifest must arrive as manifest JSON and must scope the app to /order/, the
# worker must be JavaScript and byte-identical to the file this repo ships, and
# the icons must be PNG. A 200 is not enough for any of these — the SPA fallback
# answers 200 + text/html for a path that does not exist, so a size check alone
# would pass while the app is un-installable.
printf '   %-28s ' "/order/manifest.webmanifest"
MF_CT=$(curl -s -o /tmp/pwa-manifest-live.json -w '%{http_code} %{content_type}' -m 15 "https://$DOMAIN/order/manifest.webmanifest" || true)
echo "$MF_CT"
case "$MF_CT" in
  *application/manifest+json*) ;;
  *) echo "   ERROR: the manifest is not served as application/manifest+json — Chrome will refuse to install it" >&2; exit 1 ;;
esac
if grep -q '"scope": *"/order/"' /tmp/pwa-manifest-live.json && grep -q '"start_url": *"/order/"' /tmp/pwa-manifest-live.json; then
  echo "   manifest: start_url and scope are /order/ (it cannot claim /console/)"
else
  echo "   ERROR: the live manifest does not scope the app to /order/" >&2; exit 1
fi
printf '   %-28s ' "/order/sw.js"
SW_CT=$(curl -s -o /tmp/pwa-sw-live.js -w '%{http_code} %{content_type}' -m 15 "https://$DOMAIN/order/sw.js" || true)
echo "$SW_CT"
case "$SW_CT" in
  *javascript*) ;;
  *) echo "   ERROR: the service worker is not served as JavaScript" >&2; exit 1 ;;
esac
if cmp -s /tmp/pwa-sw-live.js "$REPO/site/order/sw.js"; then
  echo "   sw.js: the live worker is byte-identical to site/order/sw.js"
else
  echo "   ERROR: /order/sw.js is not the worker this repo ships" >&2; exit 1
fi
for icon in icon-192.png icon-512.png icon-maskable-192.png icon-maskable-512.png apple-touch-icon.png; do
  printf '   %-28s ' "/order/$icon"
  ICON_CT=$(curl -s -o /dev/null -w '%{http_code} %{size_download}b %{content_type}' -m 15 "https://$DOMAIN/order/$icon" || true)
  echo "$ICON_CT"
  case "$ICON_CT" in
    *image/png*) ;;
    *) echo "   ERROR: $icon is not served as image/png — the install prompt needs raster PNGs" >&2; exit 1 ;;
  esac
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

echo "done. customer https://$DOMAIN/order/ · facilitator https://$DOMAIN/lnurlp/facilitator"
