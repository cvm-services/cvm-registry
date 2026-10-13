#!/usr/bin/env bash
# Live check of the customer-identity attach path (ADR-0018) against PRODUCTION.
# Read-only apart from one throwaway test order.
set -uo pipefail
API=https://cvm-pwa.orangesync.tech/api
PK=$(printf 'a%.0s' {1..64})
UA="Mozilla/5.0 (check)"

echo "=== 1. create a real order (no identity) ==="
ORDER=$(curl -sS -m 25 -A "$UA" -X POST "$API/orders" -H 'content-type: application/json' \
  -d '{"venue_slug":"ristorante-matera-berlin","items":[{"sku":"422081","qty":1}],"fulfilment":"pickup","inputs":{"contact.phone":"+491700000001"}}')
ID=$(printf '%s' "$ORDER" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))")
echo "order: ${ID:-FAILED}"
[ -n "$ID" ] || { echo "ABORT: no order id"; exit 1; }

echo "=== 2. a MALFORMED npub must be refused (400), and stored nowhere ==="
curl -sS -m 20 -A "$UA" -o /tmp/bad.json -w "   http %{http_code}\n" -X POST "$API/orders/$ID/identity" \
  -H 'content-type: application/json' -d '{"customer_npub":"npub1nothex"}'
python3 -c "import json;d=json.load(open('/tmp/bad.json'));print('   reason:',d.get('reason'))"

echo "=== 3. attach a VALID npub (the pay-then-sign-in case) ==="
curl -sS -m 20 -A "$UA" -o /tmp/ok.json -w "   http %{http_code}\n" -X POST "$API/orders/$ID/identity" \
  -H 'content-type: application/json' -d "{\"customer_npub\":\"$PK\"}"
cat /tmp/ok.json; echo

echo "=== 4. idempotent re-attach (same key) ==="
curl -sS -m 20 -A "$UA" -o /tmp/again.json -w "   http %{http_code}\n" -X POST "$API/orders/$ID/identity" \
  -H 'content-type: application/json' -d "{\"customer_npub\":\"$PK\"}"
cat /tmp/again.json; echo

echo "=== 5. a DIFFERENT npub must conflict (409), first identity wins ==="
curl -sS -m 20 -A "$UA" -o /tmp/conf.json -w "   http %{http_code}\n" -X POST "$API/orders/$ID/identity" \
  -H 'content-type: application/json' -d '{"customer_npub":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
cat /tmp/conf.json; echo

echo "=== 6. does the order report the identity back? ==="
curl -sS -m 20 -A "$UA" "$API/orders/$ID" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('   customer_npub:', d.get('customer_npub'))
print('   phone (real shape):', (d.get('inputs') or {}).get('contact.phone'))
print('   state:', d.get('state'))
"
echo "ORDER_ID=$ID" > /tmp/identity_check_order.env
