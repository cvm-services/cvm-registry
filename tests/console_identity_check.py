#!/usr/bin/env python3
"""Does the DEPLOYED facilitator console render a real order's identity?

Auth is the one stubbed part: the facilitator nsec is not in this workspace, so
the NIP-98 handshake cannot be performed. Everything else is real — the console
runs from production, and the order JSON is the ACTUAL response from the live
service (captured with curl, not invented).

Prints what the operator would see, and saves a screenshot.
"""
from __future__ import annotations

import json
import subprocess
import sys

from playwright.sync_api import sync_playwright

CONSOLE = "https://cvm-pwa.orangesync.tech/console/"
API = "https://cvm-pwa.orangesync.tech/api"
PK = "a" * 64
UA = "Mozilla/5.0 (check)"


def make_order() -> dict:
    """A REAL order from production, with a real attached identity."""
    out = subprocess.run(
        ["curl", "-sS", "-m", "25", "-A", UA, "-X", "POST", f"{API}/orders",
         "-H", "content-type: application/json",
         "-d", json.dumps({
             "venue_slug": "ristorante-matera-berlin",
             "items": [{"sku": "422081", "qty": 1}],
             "fulfilment": "pickup",
             "inputs": {"contact.phone": "+491700000002"},
         })],
        capture_output=True, text=True,
    )
    order = json.loads(out.stdout)
    oid = order["id"]
    subprocess.run(
        ["curl", "-sS", "-m", "20", "-A", UA, "-X", "POST", f"{API}/orders/{oid}/identity",
         "-H", "content-type: application/json",
         "-d", json.dumps({"customer_npub": PK})],
        capture_output=True, text=True,
    )
    fetched = subprocess.run(
        ["curl", "-sS", "-m", "20", "-A", UA, f"{API}/orders/{oid}"],
        capture_output=True, text=True,
    )
    return json.loads(fetched.stdout)


INIT_SCRIPT = """
(() => {
  const order = __ORDER_JSON__;
  const realFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('/api/orders/queue')) {
      return new Response(JSON.stringify({orders: [order]}),
        {status: 200, headers: {'content-type': 'application/json'}});
    }
    if (url.includes('/api/auth/challenge')) {
      // The console reads nonce + facilitatorNpub + expiresIn and validates its
      // own signed event against them, so the stub must supply the real shape.
      return new Response(JSON.stringify({
        nonce: 'stub-nonce-' + Date.now(),
        facilitatorNpub: 'c3e23eb5e3d00f18b2f4f588d8cdbc548648be761bdd90812186df4603d7caa9',
        expiresIn: 300,
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return realFetch(input, init);
  };
  // Only the operator's key is stubbed; the order payload is the real one.
  window.nostr = {
    getPublicKey: async () => 'c3e23eb5e3d00f18b2f4f588d8cdbc548648be761bdd90812186df4603d7caa9',
    signEvent: async (t) => ({...t, pubkey: 'c3e23eb5e3d00f18b2f4f588d8cdbc548648be761bdd90812186df4603d7caa9',
                              id: 'f'.repeat(64), sig: '0'.repeat(128)}),
    nip04: {encrypt: async () => 'x', decrypt: async () => 'x'},
  };
})()
"""


def main() -> int:
    order = make_order()
    print("live order from production:", json.dumps(
        {k: order.get(k) for k in ("id", "state", "subtotal", "fee", "total", "customer_npub")},
        indent=2))

    with sync_playwright() as pw:
        b = pw.chromium.launch(args=["--no-sandbox"])
        pg = b.new_context(ignore_https_errors=True).new_page()
        errors: list[str] = []
        pg.on("pageerror", lambda e: errors.append(str(e)))

        # Stub ONLY the things that need the operator's key. The order payload is
        # the real one fetched above.
        pg.add_init_script(INIT_SCRIPT.replace("__ORDER_JSON__", json.dumps(order)))
        pg.goto(CONSOLE, wait_until="domcontentloaded")
        pg.wait_for_timeout(1200)
        # Sign in through the stubbed provider so the queue view renders.
        for sel in ("[data-signin]", "button:has-text('Sign')", "button:has-text('sign')"):
            el = pg.query_selector(sel)
            if el:
                el.click()
                break
        pg.wait_for_timeout(2500)

        body = pg.inner_text("body")
        pg.screenshot(path="/tmp/console-identity.png", full_page=True)
        b.close()

    checks = {
        "signed in (no sign-in error on screen)":
            "is not the facilitator key" not in body and "no Nostr signer" not in body,
        "shows the customer's phone": "+49170" in body,
        "shows the npub (short form)": "aaaaaaaa" in body,
        "does NOT say 'no phone'": "no phone" not in body,
        "renders the order id prefix": order["id"][:8] in body,
        "no page errors": not errors,
    }
    print(json.dumps({"order_id": order["id"], "checks": checks, "errors": errors}, indent=2))
    ok = all(checks.values())
    print("PASS" if ok else "FAIL")
    if not ok:
        print("---- rendered text (first 1200 chars) ----")
        print(body[:1200])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
