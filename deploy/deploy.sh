#!/bin/bash
# Push the dashboard bundle to the hosting host and install the collector timer.
#
#   HOST=debian@23.182.128.219 bash deploy/deploy.sh
#
# Runs from a machine that (a) has deno and (b) can reach the relays, so it can
# build a first catalog before shipping. The host then refreshes it on a timer.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HOST:-debian@23.182.128.219}"
DEST="${DEST:-/opt/tollgate/cvm-dashboard}"
DENO="${DENO:-$(command -v deno || echo /home/c03rad0r/.local/bin/deno)}"
RELAYS="${RELAYS:-wss://relay.damus.io,wss://relay2.orangesync.tech}"

BUNDLE=$(mktemp -d /tmp/cvm-bundle-XXXX)
mkdir -p "$BUNDLE/site" "$BUNDLE/collector" "$BUNDLE/vocab" "$BUNDLE/deploy"
cp "$REPO"/site/index.html "$REPO"/site/app.js "$REPO"/site/style.css "$BUNDLE/site/"
cp "$REPO"/collector/*.ts "$BUNDLE/collector/"
cp "$REPO"/vocab/service-inputs.json "$BUNDLE/vocab/"
cp "$REPO"/policy.json "$REPO"/curators.json "$BUNDLE/"
cp "$REPO"/policy.json "$BUNDLE/site/policy.json"      # the page links these
cp "$REPO"/curators.json "$BUNDLE/site/curators.json"
cp "$REPO"/deploy/cvm-remote-setup.sh "$BUNDLE/deploy/"

echo "== initial collect (this host must be able to reach the relays)"
( cd "$REPO" && "$DENO" run --allow-net --allow-read --allow-write \
    collector/collect.ts --out "$BUNDLE/site/catalog.json" --relays "$RELAYS" --timeout-ms 45000 ) \
  || echo "WARN: initial collect failed; the host timer will populate the catalog"

echo "== shipping bundle to $HOST:$DEST"
tar -C "$BUNDLE" -cf - . | ssh -o BatchMode=yes "$HOST" \
  "sudo mkdir -p $DEST && sudo tar -C $DEST -xf - && sudo chown -R root:root $DEST"

echo "== installing deno on the host (no package manager needed)"
if ! ssh -o BatchMode=yes "$HOST" 'command -v /usr/local/bin/deno >/dev/null'; then
  scp -q -o BatchMode=yes "$DENO" "$HOST":/tmp/deno-cvm
  ssh -o BatchMode=yes "$HOST" "sudo install -m 0755 /tmp/deno-cvm /usr/local/bin/deno && rm -f /tmp/deno-cvm"
fi
ssh -o BatchMode=yes "$HOST" '/usr/local/bin/deno --version | head -1'

echo "== remote setup (systemd timer + Caddy site block)"
scp -q -o BatchMode=yes "$REPO"/deploy/cvm-remote-setup.sh "$HOST":/tmp/cvm-remote-setup.sh
ssh -o BatchMode=yes "$HOST" "sudo bash /tmp/cvm-remote-setup.sh"

rm -rf "$BUNDLE"
echo "== done. verify with: curl -sI https://cvm.orangesync.tech/"
