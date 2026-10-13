import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DETAIL_KIND,
  RECEIPT_KIND,
  buildDetailRecord,
  buildReceiptRecord,
  clearIdentity,
  loadIdentity,
  makeLocalSigner,
  orderKey,
  readDetail,
  readReceipt,
  saveIdentity,
  storeKey,
} from "../site/order/order_records.js";

const ORDER = "b6c61954-935d-4dcb-b8a5-5463e402da31";
const SIGNER = makeLocalSigner(new Uint8Array(32).fill(7));
const OTHER = makeLocalSigner(new Uint8Array(32).fill(9));

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k) : null),
    setItem: (k: string, v: unknown) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

const PAID_ORDER = {
  id: ORDER,
  venue_slug: "three-buddies-berlin",
  state: "paid",
  subtotal: 1500,
  fee: 120,
  total: 1620,
  items: [{ sku: "1052466", name: "Capri Sun Kirsche 0,2l", qty: 1, line_total_sats: 1500 }],
  inputs: { "contact.phone": "+491700000000" },
};

Deno.test("kinds are addressable (30000-39999) so a re-publish REPLACES, never duplicates", () => {
  for (const k of [RECEIPT_KIND, DETAIL_KIND]) {
    assert(k >= 30000 && k <= 39999, `kind ${k} must be addressable`);
    // Replaceable kinds (0, 3, 10000-19999) silently overwrite other content —
    // never use one for a per-order record.
    assert(!(k < 10000), "must not be a replaceable kind");
  }
  assert((RECEIPT_KIND as number) !== (DETAIL_KIND as number));
});

Deno.test("both records are signed by the customer's OWN key (self-custody)", async () => {
  const r = await buildReceiptRecord({ order: PAID_ORDER, signer: SIGNER, createdAt: 1 });
  const d = await buildDetailRecord({ order: PAID_ORDER, signer: SIGNER, createdAt: 1 });
  assertEquals(r.pubkey, SIGNER.pubkey);
  assertEquals(d.pubkey, SIGNER.pubkey);
  assertEquals(typeof r.id, "string");
  assertEquals(r.id.length, 64);
});

Deno.test("the receipt is PUBLIC and carries no contact detail or item list", async () => {
  const ev = await buildReceiptRecord({ order: PAID_ORDER, signer: SIGNER, createdAt: 1791912762 });

  assertEquals(ev.kind, RECEIPT_KIND);
  assertEquals(ev.content, "", "an empty content cannot leak by accident");
  const t: Record<string, string> = Object.fromEntries(ev.tags as string[][]);
  assertEquals(t.d, orderKey(ORDER));
  assertEquals(t.venue, "three-buddies-berlin");
  assertEquals(t.total, "1620");

  const blob = JSON.stringify(ev).toLowerCase();
  for (const leak of ["capri", "kirsche", "491700000000", "contact.phone", "sku"]) {
    assert(!blob.includes(leak), `receipt leaked ${leak}`);
  }
});

Deno.test("the detail record is NIP-44 encrypted: items and contact never appear in clear", async () => {
  const ev = await buildDetailRecord({ order: PAID_ORDER, signer: SIGNER, createdAt: 1791912762 });

  assertEquals(ev.kind, DETAIL_KIND);
  assertEquals((Object.fromEntries(ev.tags as string[][]) as Record<string, string>).d, orderKey(ORDER));

  const blob = JSON.stringify(ev).toLowerCase();
  for (const leak of ["capri", "kirsche", "491700000000", "contact.phone", "sku"]) {
    assert(!blob.includes(leak), `detail leaked ${leak}`);
  }
  assert(ev.content.length > 40, "content is not ciphertext");

  // Round-trips for the customer.
  const back = (await readDetail(ev, SIGNER))!;
  assertEquals(back.items[0].name, "Capri Sun Kirsche 0,2l");
  assertEquals(back.inputs["contact.phone"], "+491700000000");
  assertEquals(back.total, 1620);
});

Deno.test("readDetail refuses a foreign key instead of returning garbage", async () => {
  const ev = await buildDetailRecord({ order: PAID_ORDER, signer: SIGNER, createdAt: 1 });
  assertEquals(await readDetail(ev, OTHER), null);
});

Deno.test("readDetail never throws on a malformed or truncated event", async () => {
  assertEquals(await readDetail(null, SIGNER), null);
  assertEquals(await readDetail({ kind: DETAIL_KIND, content: "not-ciphertext" }, SIGNER), null);
  assertEquals(await readDetail({ kind: 1, content: "x" }, SIGNER), null);
});

Deno.test("readReceipt tolerates a foreign or malformed event", () => {
  assertEquals(readReceipt({ kind: 1, tags: [], content: "" }), null);
  assertEquals(readReceipt({ kind: RECEIPT_KIND, tags: [["d", 5]], content: "" }), null);
  assertEquals(readReceipt({ kind: RECEIPT_KIND, tags: [["d", "other:1"]], content: "" }), null);

  const ok = readReceipt({
    kind: RECEIPT_KIND,
    tags: [["d", orderKey(ORDER)], ["venue", "v"], ["state", "paid"], ["total", "1620"]],
    content: "",
    created_at: 5,
  });
  const r = ok!;
  assertEquals(r.order_id, ORDER);
  assertEquals(r.total, 1620);
  assertEquals(r.state, "paid");
  assertEquals(r.created_at, 5);
});

Deno.test("identity persists locally and can be cleared (never a raw nsec)", () => {
  const s = fakeStorage();
  assertEquals(loadIdentity(s), null);
  saveIdentity(s, { pubkey: SIGNER.pubkey, method: "nip46", bunker: "bunker://abc?relay=wss://r" });
  const id = loadIdentity(s)!;
  assertEquals(id.pubkey, SIGNER.pubkey);
  assertEquals(id.method, "nip46");
  assertEquals((loadIdentity(s) as Record<string, unknown>).nsec, undefined, "an identity record must never hold a private key");

  clearIdentity(s);
  assertEquals(loadIdentity(s), null);

  saveIdentity(s, { pubkey: SIGNER.pubkey, method: "nip07" });
  assert(!(storeKey() in s._dump()), "identity must not occupy the order-id key");
});
