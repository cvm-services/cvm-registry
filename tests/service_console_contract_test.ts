/**
 * CONTRACT TEST — the console must accept the payload the service actually sends.
 *
 * Three separate fields have now drifted between cvm-orders and the console's
 * expectations (`payload.basket`, `payload.customer.phone`, and the settlement
 * record), each time producing a feature that silently did nothing in
 * production. Unit tests never caught them because each side was tested against
 * its own ASSUMPTION of the other.
 *
 * So this file asserts the two ends meet: the fixtures below are VERBATIM
 * responses from the deployed service (`GET /api/orders/:id`), and the console's
 * exported pure functions must render them correctly.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { basketOf, customerOf, requireSettled } from "../site/console/app.js";

/**
 * Captured from production 2026-10-13 (order b6c61954, abbreviated to the fields
 * the console reads). Do not "tidy" this into a nicer shape — its whole value is
 * being the shape the service really returns.
 */
const LIVE_PAID_ORDER: any = {
  id: "b6c61954-935d-4dcb-b8a5-5463e402da31",
  state: "paid",
  payload: {
    venue_slug: "three-buddies-berlin",
    fulfilment: "pickup",
    items: [{
      sku: "1052466",
      name: "Capri Sun Kirsche 0,2l",
      qty: 1,
      options: ["House", "Single"],
      unit_price_sats: 1500,
      line_total_sats: 1500,
    }],
    inputs: { "contact.phone": "123" },
    settlement: {
      status: "settled",
      method: "bolt11",
      settled_at: "2026-10-13T17:07:10.962Z",
      proof: { payment_hash: "01a1363a-919b-7720-be4b-40e75b68bca1" },
    },
  },
  venue_slug: "three-buddies-berlin",
  items: [{
    sku: "1052466",
    name: "Capri Sun Kirsche 0,2l",
    qty: 1,
    options: ["House", "Single"],
    unit_price_sats: 1500,
    line_total_sats: 1500,
  }],
  subtotal: 1500,
  fee: 120,
  total: 1620,
  fulfilment: "pickup",
  inputs: { "contact.phone": "123" },
};

Deno.test("contract: the settlement gate OPENS for a real settled order", () => {
  const gate = requireSettled(LIVE_PAID_ORDER);
  assertEquals(gate.ok, true, `gate stayed closed: ${gate.reason}`);
  const proof = gate.proof!;
  assertEquals(proof.payment_hash, "01a1363a-919b-7720-be4b-40e75b68bca1");
  assertEquals(proof.method, "bolt11");
  assertEquals(proof.settled_at, "2026-10-13T17:07:10.962Z");
  assert(proof.amount_sats > 0, "the gate must see a non-zero settled amount");
});

Deno.test("contract: money renders from the real payload", () => {
  const b = basketOf(LIVE_PAID_ORDER);
  assertEquals(b.total_sats, 1620);
  assertEquals(b.total_fiat, 1.62);
  assertEquals(b.items[0].name, "Capri Sun Kirsche 0,2l");
});

Deno.test("contract: the customer's phone renders from the real payload", () => {
  assertEquals(customerOf(LIVE_PAID_ORDER).phone, "123");
});

Deno.test("contract: an UNSETTLED order still fails closed", () => {
  const pending = structuredClone(LIVE_PAID_ORDER);
  pending.payload.settlement.status = "pending";
  const gate = requireSettled(pending);
  assertEquals(gate.ok, false);
});

Deno.test("contract: an order with NO settlement record fails closed", () => {
  const none = structuredClone(LIVE_PAID_ORDER);
  delete (none.payload as Record<string, unknown>).settlement;
  assertEquals(requireSettled(none).ok, false);
});

Deno.test("contract: a settled record with no payment id fails closed", () => {
  const noProof = structuredClone(LIVE_PAID_ORDER);
  noProof.payload.settlement.proof = {};
  const gate = requireSettled(noProof);
  assertEquals(gate.ok, false);
  assert(String(gate.reason).length > 0, "a refusal must say why");
});

Deno.test("contract: an amount of zero fails closed (nothing was actually paid)", () => {
  const zero = structuredClone(LIVE_PAID_ORDER);
  zero.total = 0;
  (zero.payload.settlement as Record<string, unknown>).amount_sats = 0;
  assertEquals(requireSettled(zero).ok, false);
});

Deno.test("contract: the OLD flat shape keeps working (orders settled before this fix)", () => {
  // payload.settlement = {status, payment_hash, amount_sats} without `proof`.
  const flat = structuredClone(LIVE_PAID_ORDER);
  flat.payload.settlement = {
    status: "settled",
    method: "bolt11",
    payment_hash: "deadbeef",
    amount_sats: 1620,
    settled_at: "2026-10-13T17:07:10.962Z",
  };
  const gate = requireSettled(flat);
  assertEquals(gate.ok, true, `legacy shape broke: ${gate.reason}`);
  assertEquals(gate.proof!.payment_hash, "deadbeef");
});
