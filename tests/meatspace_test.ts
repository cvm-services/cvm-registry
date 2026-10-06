/**
 * Tests for the "meatspace" capability facet and announcement-content parsing.
 *
 * Venue announcements (class `restaurant`) now declare fulfilment / menu /
 * settlement facts inside the Nostr event `content` (a JSON string). The
 * collector was tag-only; this facet reads that content defensively and derives
 * a boolean `meatspace` facet that the dashboard can filter on.
 *
 * Run: deno test --allow-read  (no network)
 */
import {
  classify,
  groupServices,
  isMeatspace,
  parseDeclared,
  type Classified,
  type NostrEvent,
  type Vocab,
} from "../collector/lib.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error("ASSERT: " + msg);
}
function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`ASSERT (${msg}): got ${a}, want ${b}`);
}

/** Minimal slice of vocab/service-inputs.json used by the fixtures. */
const VOCAB: Vocab = {
  tiers: { none: "", financial: "", contact: "", fulfilment: "", legal: "", sensitive: "" },
  tier_tag: { ranks: { none: 0, financial: 1, contact: 2, fulfilment: 3, legal: 4, sensitive: 5 } },
  fields: {
    "payment.amount": { tier: "financial" },
    "payment.method": { tier: "financial" },
    "contact.name": { tier: "contact" },
    "contact.phone": { tier: "contact" },
    "ship.address": { tier: "fulfilment" },
    "ship.address.city": { tier: "fulfilment" },
    "order.items": { tier: "fulfilment" },
    "order.fulfilment": { tier: "fulfilment" },
    "session.meter": { tier: "fulfilment" },
  },
};

function ev(over: Partial<NostrEvent> & { tags: string[][] }): NostrEvent {
  return {
    id: over.id ?? "f".repeat(64),
    pubkey: over.pubkey ?? "a".repeat(64),
    created_at: over.created_at ?? 1_700_000_000,
    kind: over.kind ?? 11316,
    content: over.content ?? "",
    sig: over.sig ?? "0".repeat(128),
    tags: over.tags,
  };
}

/** A realistic pickup-capable venue content payload (the shape live on the relay). */
const VENUE_CONTENT = JSON.stringify({
  fulfilment: {
    methods: ["pickup", "delivery"],
    pickup: { available: true, estimated_minutes: 10 },
    delivery: { available: true, estimated_minutes: 45 },
    method_condition:
      "ship.address is required for a DELIVERY order only; pickup needs no address",
  },
  menu: {
    item_count: 42,
    priced_count: 40,
    currency: "EUR",
    min_price: 4,
    max_price: 19.5,
    prices_by_method: {
      pickup: { count: 40, min_price: 4, max_price: 19.5 },
      delivery: { count: 40, min_price: 4.5, max_price: 21.5 },
      dine_in: { count: 40, min_price: 4, max_price: 19.5 },
    },
    price_basis: "menu price; delivery adds a small surcharge",
  },
  settlement: {
    settles: "venue's own rail (ADR-0001 D5): this CVM takes no payment",
    rail: "venue's own rail (FoodAmigos storefront: Adyen/Stripe/PayPal/cash)",
    currency: "EUR",
    tax: "included in listed prices",
    cvm_cap_sats: 0,
    recorded: true,
    note: "the CVM quotes, the venue's storefront settles",
  },
});

// ------------------------------------------------------------ parseDeclared ----

Deno.test("parseDeclared: absent or empty content yields all-null, never throws", () => {
  assertEquals(parseDeclared(""), { fulfilment: null, menu: null, settlement: null }, "empty");
  assertEquals(parseDeclared("   "), { fulfilment: null, menu: null, settlement: null }, "whitespace");
});

Deno.test("parseDeclared: malformed JSON yields all-null, never throws", () => {
  for (const bad of ["not json", "{", "[1,2", "{\"fulfilment\":", "null", "123", "\"str\"", "true", "[]"]) {
    assertEquals(
      parseDeclared(bad),
      { fulfilment: null, menu: null, settlement: null },
      `malformed content is inert: ${JSON.stringify(bad)}`,
    );
  }
});

Deno.test("parseDeclared: a valid venue content carries fulfilment/menu/settlement facts", () => {
  const d = parseDeclared(VENUE_CONTENT);
  assertEquals(d.fulfilment?.methods, ["pickup", "delivery"], "fulfilment methods");
  assertEquals(d.fulfilment?.pickup?.estimated_minutes, 10, "pickup wait minutes");
  assertEquals(d.fulfilment?.delivery?.available, true, "delivery availability");
  assertEquals(d.menu?.currency, "EUR", "menu currency");
  assertEquals(d.menu?.prices_by_method?.pickup?.min_price, 4, "pickup min price");
  assertEquals(d.settlement?.settles, "venue's own rail (ADR-0001 D5): this CVM takes no payment", "settlement rail");
  assertEquals(d.settlement?.cvm_cap_sats, 0, "cvm cap");
});

Deno.test("parseDeclared: a non-object content (e.g. a tools array) yields all-null", () => {
  // the 11317 tools facet carries {"tools":[...]} — not fulfilment/menu/settlement
  assertEquals(
    parseDeclared(JSON.stringify({ tools: [{ name: "sms.send" }] })),
    { fulfilment: null, menu: null, settlement: null },
    "unrelated keys are ignored, not misread",
  );
});

Deno.test("parseDeclared: partially-present content keeps present facts, nulls the rest", () => {
  const d = parseDeclared(JSON.stringify({ menu: { item_count: 7 } }));
  assertEquals(d.menu?.item_count, 7, "menu survives");
  assertEquals(d.fulfilment, null, "fulfilment absent -> null");
  assertEquals(d.settlement, null, "settlement absent -> null");
});

// ------------------------------------------------------------ meatspace facet ----

Deno.test("meatspace: a pickup venue with no required ship.* is true", () => {
  const c = classify(
    ev({
      content: VENUE_CONTENT,
      tags: [
        ["t", "cvm:service:restaurant"],
        ["t", "cvm:req:order.fulfilment"],
        ["t", "cvm:req:contact.phone"],
        ["t", "cvm:opt:ship.address"],
      ],
    }),
    VOCAB,
  );
  assertEquals(c.meatspace, true, "pickup is a physical handover and ship.address is only optional");
  assertEquals(c.declared.fulfilment?.methods, ["pickup", "delivery"], "facts carried on the entry");
});

Deno.test("meatspace: a delivery-only venue that REQUIRES ship.address is false", () => {
  const c = classify(
    ev({
      content: JSON.stringify({ fulfilment: { methods: ["delivery"], delivery: { available: true } } }),
      tags: [
        ["t", "cvm:service:restaurant"],
        ["t", "cvm:req:ship.address"],
        ["t", "cvm:req:contact.phone"],
      ],
    }),
    VOCAB,
  );
  assertEquals(c.meatspace, false, "a required ship.address rules out a physical handover");
});

Deno.test("meatspace: a digital service that requires nothing (class compute, tier none) is false", () => {
  const c = classify(
    ev({
      content: "",
      tags: [["t", "cvm:service:compute"], ["t", "cvm:req:none"], ["t", "cvm:tier:none"]],
    }),
    VOCAB,
  );
  assertEquals(c.meatspace, false, "no ship.* requirement alone must not imply meatspace");
});

Deno.test("meatspace: a service that requires only payment.amount (class sms) is false", () => {
  const c = classify(
    ev({
      content: "",
      tags: [["t", "cvm:service:sms"], ["t", "cvm:req:payment.amount"], ["t", "cvm:tier:financial"]],
    }),
    VOCAB,
  );
  assertEquals(c.meatspace, false, "settlement-only input is not a physical handover");
});

Deno.test("meatspace: the explicit cvm:service:meatspace class tag is an additional signal", () => {
  // A venue that does not (yet) publish content.fulfilment can still opt in via
  // the parallel class tag; treat it as additive, never as a dependency.
  const c = classify(
    ev({
      content: "",
      tags: [["t", "cvm:service:restaurant"], ["t", "cvm:service:meatspace"], ["t", "cvm:req:order.fulfilment"]],
    }),
    VOCAB,
  );
  assertEquals(c.meatspace, true, "the class tag declares a physical handover on its own");
  assert(c.classes.includes("meatspace"), "the class tag also surfaces as a class");
});

Deno.test("meatspace: dine_in is a physical handover too", () => {
  const c = classify(
    ev({
      content: JSON.stringify({ fulfilment: { methods: ["dine_in"] } }),
      tags: [["t", "cvm:service:restaurant"], ["t", "cvm:req:order.fulfilment"]],
    }),
    VOCAB,
  );
  assertEquals(c.meatspace, true, "dine_in is an in-person handover");
});

// ----------------------------------------------------- meatspace on services ----

Deno.test("meatspace merges to the grouped service: any meatspace facet makes the service meatspace", () => {
  const pk = "a".repeat(64);
  const venue = classify(
    ev({ id: "1".repeat(64), pubkey: pk, kind: 11316, content: VENUE_CONTENT,
      tags: [["t", "cvm:service:restaurant"], ["t", "cvm:req:order.fulfilment"], ["t", "cvm:opt:ship.address"]] }),
    VOCAB,
  );
  const tools = classify(
    ev({ id: "2".repeat(64), pubkey: pk, kind: 11317, content: JSON.stringify({ tools: [] }),
      tags: [["t", "cvm:req:payment.amount"]] }),
    VOCAB,
  );
  const out = groupServices([venue, tools]);
  assertEquals(out.length, 1, "one service");
  assertEquals(out[0].meatspace, true, "the 11316 venue facet makes the service meatspace");
  assertEquals(out[0].declared.fulfilment?.methods, ["pickup", "delivery"], "declared facts survive the merge");
});

Deno.test("meatspace merges honestly: a non-meatspace service stays false", () => {
  const pk = "b".repeat(64);
  const sms = classify(
    ev({ id: "3".repeat(64), pubkey: pk, kind: 11316, content: "",
      tags: [["t", "cvm:service:sms"], ["t", "cvm:req:payment.amount"]] }),
    VOCAB,
  );
  const out = groupServices([sms]);
  assertEquals(out[0].meatspace, false, "sms never becomes meatspace");
});

// ------------------------------------------------------------ isMeatspace pure ----

Deno.test("isMeatspace: clause (1) and clause (2) are both required", () => {
  const none = { fulfilment: null, menu: null, settlement: null };
  // no ship.* but also no physical handover => false (the digital-services guard)
  assertEquals(isMeatspace([], [], none), false, "vacuous clause (1) alone is not enough");
  // ship.* required => false even with a pickup method declared
  const pickup = { fulfilment: { methods: ["pickup"], pickup: { available: true }, delivery: null, dine_in: null, method_condition: null }, menu: null, settlement: null };
  assertEquals(isMeatspace(["ship.address"], [], pickup), false, "required ship.* vetoes meatspace");
  // both satisfied => true
  assertEquals(isMeatspace([], [], pickup), true, "pickup + no ship.* is meatspace");
});
