#!/bin/bash
# Runs ON the dashboard host as root (installed by deploy/deploy.sh).
#
# Installs:
#   * /etc/systemd/system/cvm-collector.{service,timer}  — refresh the cache
#   * a Caddy site block for cvm.orangesync.tech          — serve site/ as files
# Idempotent: re-running replaces the units and appends the Caddy block once.
set -euo pipefail
DEST=/opt/tollgate/cvm-dashboard

if [ ! -f "$DEST/collector/collect.ts" ]; then
  echo "ERROR: $DEST/collector/collect.ts missing — push the bundle first" >&2
  exit 1
fi

cat > /etc/systemd/system/cvm-collector.service <<'EOF'
[Unit]
Description=cvm-registry collector — CEP-6 announcements into a static catalog
Documentation=https://github.com/cvm-services/cvm-registry
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/tollgate/cvm-dashboard
ExecStart=/usr/local/bin/deno run --allow-net --allow-read --allow-write /opt/tollgate/cvm-dashboard/collector/collect.ts --out /opt/tollgate/cvm-dashboard/site/catalog.json --timeout-ms 60000
TimeoutStartSec=240
User=root
EOF

cat > /etc/systemd/system/cvm-collector.timer <<'EOF'
[Unit]
Description=Refresh the cvm-registry catalog regularly (the ttl lives in policy.json)

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min
Unit=cvm-collector.service

[Install]
WantedBy=timers.target
EOF

if ! grep -q 'cvm.orangesync.tech' /etc/caddy/Caddyfile; then
  cat >> /etc/caddy/Caddyfile <<'EOF'

# cvm-registry discovery dashboard — a cache, not a proxy.
# Source: https://github.com/cvm-services/cvm-registry (deploy/cvm-remote-setup.sh)
cvm.orangesync.tech {
	root * /opt/tollgate/cvm-dashboard/site
	file_server
	encode gzip
	header {
		Cache-Control "no-cache"
		X-Content-Type-Options "nosniff"
	}
}
EOF
  echo "appended Caddy site block"
else
  echo "Caddy site block already present"
fi

# Caddy runs as user 'caddy' and must be able to traverse/read the tree.
# /opt/tollgate is 0711 (traverse, not list); the dashboard itself is world-readable.
chmod 0711 /opt/tollgate
find "$DEST" -type d -exec chmod 0755 {} +
find "$DEST" -type f -exec chmod 0644 {} +

caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
  echo "caddy config: valid"
else
  echo "caddy config: INVALID — not reloading" >&2
  exit 1
fi

systemctl daemon-reload
systemctl enable --now cvm-collector.timer >/dev/null
systemctl start cvm-collector.service || echo "WARN: first collect failed; the timer will retry"
systemctl reload caddy
sleep 1
echo "timer: $(systemctl is-active cvm-collector.timer)"
echo "caddy: $(systemctl is-active caddy)"
ls -l "$DEST/site/catalog.json" 2>/dev/null || echo "no catalog yet"
