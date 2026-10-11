#!/usr/bin/env bash
# Final RED proof: the PUSHED test file (with the strengthened assertions) run against the
# SHIPPED vhost from origin/main. Also run against the fixed vhost for the green half.
set -uo pipefail
WT=/home/c03rad0r/worktrees/t_cdc4442b
SC=/home/c03rad0r/scratch/t_cdc4442b
OUT=$WT/evidence/t_cdc4442b
cd "$WT" || exit 1
cp deploy/caddy-vhost-cvm-pwa.caddy "$SC/vhost-final-good.caddy"

echo "== branch vhost sha: $(git rev-parse HEAD:deploy/caddy-vhost-cvm-pwa.caddy)"
echo "== origin/main vhost sha: $(git rev-parse origin/main:deploy/caddy-vhost-cvm-pwa.caddy)"
git show origin/main:deploy/caddy-vhost-cvm-pwa.caddy > deploy/caddy-vhost-cvm-pwa.caddy
echo "=== RED: final tests vs origin/main vhost (full suite) ==="
deno test --allow-read --allow-net --allow-env tests/ 2>&1 | tee "$OUT/RED-final-vs-shipped-vhost.txt" | tail -12
echo "suite exit: ${PIPESTATUS[0]}"

cp "$SC/vhost-final-good.caddy" deploy/caddy-vhost-cvm-pwa.caddy
echo "=== GREEN: final tests vs branch vhost (full suite) ==="
deno test --allow-read --allow-net --allow-env tests/ 2>&1 | tee "$OUT/GREEN-final-branch-vhost.txt" | tail -4
echo "suite exit: ${PIPESTATUS[0]}"
echo "== vhost restored to the branch version: $(git diff --stat deploy/caddy-vhost-cvm-pwa.caddy | tail -1)"
