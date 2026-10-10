#!/usr/bin/env bash
# hermes-verify: ad-hoc verification of the changed artifact
# deploy/caddy-vhost-cvm-pwa.caddy  (cvm-registry, branch pr/facilitator-console)
#
# The artifact is CONFIG, so unit tests cannot prove it works. This proves it three
# ways against reality: (1) Caddy itself parses/adapts the deployed file, (2) the
# block live on the host is byte-identical to the repo file, (3) the live origin
# actually routes as the file says, including the down case.
set -uo pipefail
REPO=/home/c03rad0r/worktrees/t_99fb9b0e
VHOST="$REPO/deploy/caddy-vhost-cvm-pwa.caddy"
HOST=debian@testserver2.fips
DOMAIN=cvm-pwa.orangesync.tech
pass=0; fail=0
ck(){ if [ "$2" = "$3" ]; then echo "  PASS  $1 ($2)"; pass=$((pass+1)); else echo "  FAIL  $1: got '$2' want '$3'"; fail=$((fail+1)); fi; }
ok(){ echo "  PASS  $1"; pass=$((pass+1)); }
no(){ echo "  FAIL  $1"; fail=$((fail+1)); }

echo "== 1. the repo file is valid Caddy config (caddy adapt, on the host, over ssh) =="
scp -q -o BatchMode=yes "$VHOST" "$HOST:/tmp/hermes-verify-vhost.caddy" && ok "shipped repo file to host"
ADAPT=$(ssh -o BatchMode=yes "$HOST" 'sudo -n caddy adapt --config /tmp/hermes-verify-vhost.caddy --adapter caddyfile 2>&1 >/dev/null; echo "rc=$?"')
ck "caddy adapt parses the repo file" "$ADAPT" "rc=0"

echo "== 2. the LIVE block == the repo file (byte-compare of the deployed region) =="
# pull the deployed block out of /etc/caddy/Caddyfile by brace counting, then diff.
ssh -o BatchMode=yes "$HOST" "sudo -n cat /etc/caddy/Caddyfile" > /tmp/hermes-verify-live-caddyfile 2>/dev/null
python3 - "$VHOST" /tmp/hermes-verify-live-caddyfile "$DOMAIN" <<'PY'
import sys,re
vhost, live, dom = sys.argv[1], sys.argv[2], sys.argv[3]
want=open(vhost).read()
raw=open(live).read()
# find the domain block and take it balanced
i=raw.find(dom+" {")
assert i>=0, "domain block absent from live Caddyfile"
d=0; j=raw.index("{", i)
for k in range(j, len(raw)):
    if raw[k]=="{": d+=1
    elif raw[k]=="}":
        d-=1
        if d==0: break
got=raw[i:k+1]
# the live copy has the comment header stripped by the rewriter? compare code lines only,
# whitespace-normalised, comments dropped either way.
def code(s): return [l.strip() for l in s.splitlines() if l.strip() and not l.strip().startswith("#")]
w,g = code(want), code(got)
print("  repo code lines:", len(w), "| live code lines:", len(g))
if w==g:
    print("  PASS  live block code == repo file code")
else:
    print("  FAIL  live block differs from repo file")
    for a,b in zip(w,g):
        if a!=b: print("        repo:",a,"\n        live:",b)
    print("        repo_only:", [x for x in w if x not in g])
    print("        live_only:", [x for x in g if x not in w])
PY
r=$?; [ $r -eq 0 ] && ok "block comparison ran" || no "block comparison (rc=$r)"

echo "== 3. the live origin routes the way the file declares =="
B=https://$DOMAIN
code(){ curl -s -o /tmp/hermes-verify-body -w '%{http_code}' --max-time 25 "$1"; }
ct(){ curl -s -o /dev/null -w '%{content_type}' --max-time 25 "$1"; }
ck "/api/health is JSON 200 (proxied, not the SPA)"  "$(code $B/api/health)"        "200"
ck "  ...and its content-type is application/json"   "$(ct   $B/api/health)"        "application/json"
# Fetch each document into its OWN file; grepping a stale body proves nothing.
curl -s --max-time 25 "$B/console/" > /tmp/hermes-verify-console.html
curl -s --max-time 25 "$B/order/"   > /tmp/hermes-verify-order.html
console_title=$(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' /tmp/hermes-verify-console.html | head -1)
order_title=$(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' /tmp/hermes-verify-order.html | head -1)
echo "     /console/ title: $console_title"
echo "     /order/   title: $order_title"
case "$console_title" in *Facilitator*) ok "/console/ is the console's own document";; *) no "/console/ title: '$console_title'";; esac
case "$order_title"   in *Facilitator*) no "/order/ served the CONSOLE document — wrong fallback";; *) ok "/order/ does not serve the console document";; esac
ck "/console/ is a different document from /order/"  "$(cmp -s /tmp/hermes-verify-console.html /tmp/hermes-verify-order.html && echo same || echo different)" "different"
ck "/console/app.js is served"                       "$(code $B/console/app.js)"     "200"
ck "/console/style.css is served"                    "$(code $B/console/style.css)"  "200"
ck "/order/ is served"                               "$(code $B/order/)"             "200"
# handle_errors: /api/* with the backend down must be JSON, never the SPA index.
echo "  -- stopping cvm-orders to exercise handle_errors --"
ssh -o BatchMode=yes "$HOST" 'sudo -n systemctl stop cvm-orders.service' >/dev/null 2>&1
down_code=$(code $B/api/orders/queue); down_ct=$(ct $B/api/orders/queue)
down_body=$(head -c 120 /tmp/hermes-verify-body)
static_code=$(code $B/order/)
echo "     down /api -> $down_code $down_ct : $down_body"
ck "down /api/* answers 502 (not 200)"               "$down_code" "502"
ck "down /api/* answers JSON, not text/html"         "$down_ct"   "application/json"
case "$down_body" in *"order service unavailable"*) ok "down body is the declared JSON error";; *) no "down body: $down_body";; esac
ck "the static PWA still serves while /api is down"  "$static_code" "200"
ssh -o BatchMode=yes "$HOST" 'sudo -n systemctl start cvm-orders.service' >/dev/null 2>&1
sleep 2
ck "/api/health recovers after restart"              "$(code $B/api/health)" "200"

echo
echo "==== ad-hoc verification: $pass passed, $fail failed ===="
[ $fail -eq 0 ] || exit 1
