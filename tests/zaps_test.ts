/**
 * Tests for zap receipts (R3).
 *
 * The one that matters most is the LAST test: zaps must not reorder anything.
 * "Zaps rank reviews" is the intuitive feature, and it is the one being refused
 * on purpose — a zap is purchasable, so ranking by it reproduces the paid-review
 * problem it is supposed to solve. If someone later adds a sort key, that test
 * fails and sends them to ADR-0002.
 */

import {
  attachZaps,
  classifyZap,
  isZapReceipt,
  parseZapRequest,
  tallyZapsByTarget,
  ZAP_RECEIPT_KIND,
} from "../collector/zaps.ts";

const REVIEW_ID = "44f9270c09ba7243603b209b87fe0148b284ccdd8f31bc1dd356331809e45aa7";
const REVIEW_ID_2 = "95ffbfe506e79bacbef91a295b540f449b1cdfddd428380bbfbf901cd2dc848a";
const PAYER = "87c3a21fd09fe893a22f10b404d4953ce95d1c9e2fded64c37d3acaab65b82d9";

function receipt(over: Record<string, unknown> = {}) {
  return {
    id: "a".repeat(64),
    kind: ZAP_RECEIPT_KIND,
    pubkey: "c".repeat(64), // the LNURL server signs receipts, not the payer
    created_at: 1791223700,
    content: "",
    sig: "0".repeat(128),
    tags: [
      ["p", "d".repeat(64)],
      ["e", REVIEW_ID],
      ["P", PAYER],
      ["amount", "21000"], // millisats
      ["bolt11", "lnbc210n1p..."],
    ],
    ...over,
  };
}

function eq(a: unknown, b: unknown, what: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
  }
}
function ok(cond: unknown, what: string) {
  if (!cond) throw new Error(what);
}

Deno.test("zaps: a receipt is read, millisats converted, sender and target kept", () => {
  const z = classifyZap(receipt())!;
  ok(z, "receipt not classified");
  eq(z.sats, 21, "21000 msats is 21 sats");
  eq(z.millisats, 21000, "millisats");
  eq(z.amount_source, "receipt-amount", "source");
  eq(z.target_event_id, REVIEW_ID, "target review");
  eq(z.sender_pubkey, PAYER, "payer from the P tag");
  eq(z.warnings, [], "a clean receipt carries no warnings");
});

Deno.test("zaps: amount falls back to the zap request inside `description`", () => {
  const req = JSON.stringify({
    kind: 9734,
    pubkey: PAYER,
    content: "great pizza",
    tags: [["amount", "5000"], ["p", "d".repeat(64)]],
  });
  const z = classifyZap(receipt({ tags: [["p", "x"], ["e", REVIEW_ID], ["description", req]] }))!;
  eq(z.sats, 5, "5000 msats from the zap request");
  eq(z.amount_source, "request-amount", "source");
  eq(z.sender_pubkey, PAYER, "payer recovered from the request");
  eq(z.comment, "great pizza", "zap comment");
});

Deno.test("zaps: an unreadable amount is reported, never estimated as zero", () => {
  const z = classifyZap(receipt({ tags: [["p", "x"], ["e", REVIEW_ID], ["bolt11", "lnbc1..."]] }))!;
  eq(z.sats, null, "no amount => null, not 0");
  ok(z.warnings.includes("amount-unknown:no-amount-tag-and-no-decoded-bolt11"), `got ${JSON.stringify(z.warnings)}`);
  ok(z.warnings.includes("sender-unknown"), "sender must be flagged too");

  const t = tallyZapsByTarget([z]).get(REVIEW_ID)!;
  eq(t.count, 1, "still counted");
  eq(t.sats_known, 0, "sums nothing");
  eq(t.count_amount_unknown, 1, "and says so");
});

Deno.test("zaps: malformed description is survivable", () => {
  const bad = parseZapRequest({ tags: [["description", "{not json"]], kind: 9735, pubkey: "x", id: "y", created_at: 1, content: "", sig: "0".repeat(128) });
  eq(bad.amount_msats, null, "no amount");
  eq(bad.sender_pubkey, null, "no sender");
});

Deno.test("zaps: a receipt with no target is not a zap", () => {
  eq(isZapReceipt(receipt({ tags: [["p", "x"], ["amount", "1000"]] })), false, "no e tag => not a zap receipt");
  eq(classifyZap(receipt({ tags: [["p", "x"], ["amount", "1000"]] })), null, "not classified");
  eq(classifyZap(receipt({ kind: 1 })), null, "wrong kind");
});

Deno.test("zaps: tally sums per target and lists distinct senders once", () => {
  const a = classifyZap(receipt({ id: "1".repeat(64), tags: [["p", "x"], ["e", REVIEW_ID], ["P", PAYER], ["amount", "1000"]] }))!;
  const b = classifyZap(receipt({ id: "2".repeat(64), tags: [["p", "x"], ["e", REVIEW_ID], ["P", PAYER], ["amount", "2000"]] }))!;
  const other = classifyZap(receipt({ id: "3".repeat(64), tags: [["p", "x"], ["e", REVIEW_ID_2], ["P", "e".repeat(64)], ["amount", "7000"]] }))!;
  const tallies = tallyZapsByTarget([a, b, other]);
  const first = tallies.get(REVIEW_ID)!;
  eq(first.count, 2, "two receipts");
  eq(first.sats_known, 3, "1 + 2 sats");
  eq(first.senders.length, 1, "the same payer twice is one sender");
  eq(tallies.get(REVIEW_ID_2)!.sats_known, 7, "the other review is tallied separately");
});

Deno.test("zaps: attaching does not reorder reviews — this is the point of R3", () => {
  // Deliberately: the OLDER review has far more sats behind it.
  interface Row { event_id: string; created_at: number; content: string }
  const oldButRich: Row = { event_id: REVIEW_ID, created_at: 100, content: "old" };
  const newButPoor: Row = { event_id: REVIEW_ID_2, created_at: 900, content: "new" };
  const rich = (id: string) => classifyZap(receipt({ id: id, tags: [["p", "x"], ["e", REVIEW_ID], ["P", PAYER], ["amount", "1000000000"]] }))!;
  const tallies = tallyZapsByTarget([rich("9".repeat(64)), rich("8".repeat(64))]);

  const before = [oldButRich, newButPoor].map((r) => r.event_id);
  const res = attachZaps([oldButRich, newButPoor], tallies);
  const after = res.reviews.map((r) => r.event_id);

  eq(after, before, "order must be untouched by zap totals");
  eq(res.reviews[0].created_at, 100, "the older review stays first");
  eq(res.reviews_with_zaps, 1, "one review carries a tally");
  eq(res.sats_total, 2_000_000, "sats are surfaced for display, not for ranking");
  eq(attachZaps([oldButRich, newButPoor], new Map()).reviews[0].zaps, null,
    "a review with no zaps gets null, not a zeroed tally that looks like data");
});

Deno.test("zaps: the label tells the reader what the number is", () => {
  const z = classifyZap(receipt())!;
  const t = tallyZapsByTarget([z]).get(REVIEW_ID)!;
  eq(t.label, "zaps are a spend signal, not a score", "label");
});
