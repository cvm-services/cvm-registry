#!/usr/bin/env bash
# Regenerate site/order/vendor/nostr.mjs from site/order/vendor/nostr-entry.js.
#
# The committed bundle is what ships — this script exists so the bundle can be
# reproduced byte-for-byte from a clean checkout. It resolves nostr-tools from a
# local node_modules (no network at build time); pass NOSTR_TOOLS_ROOT to point
# at one.
#
#   bash scripts/vendor-nostr.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$REPO/site/order/vendor/nostr-entry.js"
OUT="$REPO/site/order/vendor/nostr.mjs"
ROOT="${NOSTR_TOOLS_ROOT:-/data/repos/auditable-voting/web/node_modules}"
VERSION="2.23.3"

if [ ! -d "$ROOT/nostr-tools" ]; then
  echo "nostr-tools not found under $ROOT — set NOSTR_TOOLS_ROOT" >&2
  exit 1
fi

# Pin the version we bundle; a silent major bump would change the wire format.
GOT="$(python3 -c "import json;print(json.load(open('$ROOT/nostr-tools/package.json'))['version'])")"
if [ "$GOT" != "$VERSION" ]; then
  echo "nostr-tools version is $GOT, expected $VERSION — update VENDOR.md + this script" >&2
  exit 1
fi

NODE_PATH="$ROOT" npx --yes esbuild@0.28.1 "$ENTRY" \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile="$OUT" --legal-comments=inline

echo "wrote $OUT"
sha256sum "$OUT"
