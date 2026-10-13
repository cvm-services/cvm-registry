#!/usr/bin/env python3
"""Live browser check of the customer Nostr login (ADR-0017).

Runs against the DEPLOYED PWA and proves the flow end-to-end in a real browser:

  1. the page loads with NO module errors (the vendor bundle resolves, MIME ok)
  2. a stubbed NIP-46 bunker signs in, and the order is published to a REAL relay
  3. localStorage is wiped (the "new device" case) and the order comes back
     from the relay alone — the whole point of the feature

The bunker is stubbed in-page (a real one needs a human) but everything below
it — NIP-44 encryption, event building, relay publish/subscribe — is the real
implementation talking to a real relay.

  ~/.cache/pw-venv/bin/python live_login_check.py [--url ...] [--shot out.png]
"""
from __future__ import annotations

import argparse
import json
import sys

from playwright.sync_api import sync_playwright

# A throwaway key for the stub signer. Never a real identity.
TEST_SK = "11" * 32


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="https://cvm-pwa.orangesync.tech/order/")
    ap.add_argument("--relay", default="wss://relay.primal.net")
    ap.add_argument("--shot", default="")
    ap.add_argument("--timeout", type=int, default=90000)
    args = ap.parse_args()

    errors: list[str] = []
    result: dict = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()

        # Anything the page logs as an error or throws is a failure: module
        # resolution and MIME problems only ever show up here.
        page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))

        page.goto(args.url, wait_until="domcontentloaded")
        page.wait_for_function("!!window.__orderReady || !!document.querySelector('.screen')", timeout=args.timeout)

        # ---- 1. the modules resolved in a real browser --------------------
        probe = page.evaluate(
            """async () => {
                const out = {ok: true, steps: []};
                try {
                    const rec = await import('/order/order_records.js');
                    const relay = await import('/order/order_relay.js');
                    const idn = await import('/order/identity.js');
                    const v = await import('/order/vendor/nostr.mjs');
                    out.steps.push('modules imported');
                    out.exports = {
                      records: Object.keys(rec).length,
                      relay: Object.keys(relay).length,
                      identity: Object.keys(idn).length,
                      vendor: ['finalizeEvent','SimplePool','nip44','BunkerSigner']
                        .filter(k => k in v).length,
                    };
                    out.relays = relay.RELAYS;
                } catch (e) { out.ok = false; out.error = String(e); }
                return out;
            }"""
        )
        result["modules"] = probe
        if not probe.get("ok"):
            print(json.dumps({"PASS": False, "stage": "modules", "detail": probe}, indent=2))
            browser.close()
            return 1

        # ---- 2. sign in (stubbed bunker) and publish to a REAL relay -------
        publish = page.evaluate(
            """async ([skHex, relayUrl]) => {
                const rec = await import('/order/order_records.js');
                const relay = await import('/order/order_relay.js');
                const v = await import('/order/vendor/nostr.mjs');
                const sk = Uint8Array.from(skHex.match(/../g).map(h => parseInt(h, 16)));
                const signer = rec.makeLocalSigner(sk);
                const order = {
                    id: 'browser-check-' + Date.now(),
                    venue_slug: 'three-buddies-berlin',
                    state: 'paid',
                    subtotal: 1500, fee: 120, total: 1620,
                    items: [{ sku: '1052466', name: 'Capri Sun Kirsche 0,2l', qty: 1, line_total_sats: 1500 }],
                    inputs: { 'contact.phone': '+491700000000' },
                };
                const receipt = await rec.buildReceiptRecord({order, signer, createdAt: Math.floor(Date.now()/1000)});
                const detail = await rec.buildDetailRecord({order, signer, createdAt: Math.floor(Date.now()/1000)});
                const pool = new v.SimplePool();
                const out = await relay.publishOrderRecords(pool, [relayUrl], {receipt, detail});
                out.pubkey = signer.pubkey;
                out.order_id = order.id;
                // the receipt must NOT carry the item name
                out.receipt_clean = !JSON.stringify(receipt).toLowerCase().includes('capri');
                out.detail_encrypted = !JSON.stringify(detail).toLowerCase().includes('capri');
                return out;
            }""",
            [TEST_SK, args.relay],
        )
        result["publish"] = publish
        if publish.get("relays_ok", 0) < 1:
            print(json.dumps({"PASS": False, "stage": "publish", "detail": publish}, indent=2))
            browser.close()
            return 1

        # ---- 3. wipe local state, then recover from the relay alone --------
        recover = page.evaluate(
            """async ([pubkeyHex, orderId, relayUrl]) => {
                const rec = await import('/order/order_records.js');
                const relay = await import('/order/order_relay.js');
                const v = await import('/order/vendor/nostr.mjs');
                const sk = Uint8Array.from(('%s').match(/../g).map(h => parseInt(h, 16)));
                // Simulate a NEW DEVICE: no localStorage at all.
                try { localStorage.clear(); } catch (e) {}
                const signer = rec.makeLocalSigner(sk);
                const pool = new v.SimplePool();
                const receipts = await relay.fetchReceipts(pool, [relayUrl], pubkeyHex, {timeoutMs: 15000});
                const mine = receipts.find(r => r.order_id === orderId);
                let items = null;
                if (mine) {
                    const ev = await relay.fetchDetail(pool, [relayUrl], pubkeyHex, orderId, {timeoutMs: 15000});
                    const d = ev ? await rec.readDetail(ev, signer) : null;
                    items = d?.items?.[0]?.name ?? null;
                }
                return {found: !!mine, state: mine?.state ?? null, total: mine?.total ?? null,
                        items_recovered: items, count: receipts.length};
            }""".replace('%s', TEST_SK),
            [publish["pubkey"], publish["order_id"], args.relay],
        )
        result["recover"] = recover

        if args.shot:
            page.screenshot(path=args.shot, full_page=False)
        browser.close()

    ok = (
        result["modules"].get("ok")
        and publish.get("relays_ok", 0) >= 1
        and publish.get("receipt_clean") is True
        and publish.get("detail_encrypted") is True
        and recover.get("found") is True
        and recover.get("items_recovered") == "Capri Sun Kirsche 0,2l"
        and not errors
    )
    print(json.dumps({"PASS": ok, "errors": errors, **result}, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
